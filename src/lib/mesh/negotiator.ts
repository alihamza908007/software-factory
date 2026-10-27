import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT, getAgent, getProject, listAgents } from "../db";
import { generateWithAgent } from "../providers/router";
import { applyFileBlocks, parseFileBlocks } from "../orchestrator/parse";
import type { Agent, NegotiationMessage, Project } from "../types";
import { uid } from "../utils";
import { appendConstraint } from "./agent-memory";
import { inferResolutionPath, meshBus, publishAgentEnvelope, setMeshAgentStatus } from "./event-bus";
import { listWorkspaceFiles } from "../workspace";

export interface NegotiationRequest {
  leftAgentId: string;
  rightAgentId: string;
  topic: string;
  leftArtifact?: string;
  rightArtifact?: string;
  context?: string;
  projectId?: string;
  threadId?: string;
  maxRounds?: number;
  autoApply?: boolean;
}

export interface NegotiationState {
  id: string;
  status: "running" | "resolved" | "failed";
  request: NegotiationRequest;
  messages: NegotiationMessage[];
  rounds: number;
  agreement?: string;
  appliedFiles: string[];
  error?: string;
  startedAt: number;
  completedAt?: number;
}

interface NegotiationGlobal {
  __factoryNegotiations?: Map<string, NegotiationState>;
}

const globalStore = globalThis as typeof globalThis & NegotiationGlobal;
const jobs = (globalStore.__factoryNegotiations ??= new Map<string, NegotiationState>());

const NEGOTIATION_PATH = path.join(DATA_ROOT, "negotiations.json");
interface PersistedNegotiations {
  version: 1;
  negotiations: NegotiationState[];
  updatedAt: number;
}
const negotiationGlobal = globalThis as typeof globalThis & {
  __factoryNegotiationsHydrated?: boolean;
  __factoryNegotiationsWrite?: Promise<void>;
};

export async function hydrateNegotiations(): Promise<void> {
  if (negotiationGlobal.__factoryNegotiationsHydrated) return;
  negotiationGlobal.__factoryNegotiationsHydrated = true;
  try {
    const raw = await fs.readFile(NEGOTIATION_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedNegotiations>;
    for (const negotiation of parsed.negotiations ?? []) {
      if (!negotiation?.id) continue;
      const restored =
        negotiation.status === "running"
          ? {
              ...negotiation,
              status: "failed" as const,
              error: "Server restarted while this negotiation was running. Restart it with the retained topic.",
              completedAt: Date.now(),
            }
          : negotiation;
      const existing = jobs.get(restored.id);
      if (!existing || existing.startedAt <= restored.startedAt) {
        jobs.set(restored.id, restored);
      }
    }
  } catch {
    // First run; nothing to restore.
  }
}

function persistNegotiations(): void {
  const snapshot: PersistedNegotiations = {
    version: 1,
    negotiations: Array.from(jobs.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-30),
    updatedAt: Date.now(),
  };
  negotiationGlobal.__factoryNegotiationsWrite = (
    negotiationGlobal.__factoryNegotiationsWrite ?? Promise.resolve()
  )
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(DATA_ROOT, { recursive: true });
      const tmp = `${NEGOTIATION_PATH}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await fs.rename(tmp, NEGOTIATION_PATH);
    })
    .catch(() => undefined);
}


async function flushNegotiations(): Promise<void> {
  persistNegotiations();
  await (negotiationGlobal.__factoryNegotiationsWrite ?? Promise.resolve());
}

/**
 * Persist a completed transcript that was produced outside the peer loop
 * (for example the orchestrator's one-turn task ownership negotiation).
 * The write is awaited so execution never starts before the audit record exists.
 */
export async function recordTaskNegotiation(state: NegotiationState): Promise<void> {
  await hydrateNegotiations();
  jobs.set(state.id, state);
  if (jobs.size > 30) {
    const oldest = Array.from(jobs.values())
      .filter((job) => job.status !== "running")
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  await flushNegotiations();
}

function pickAgent(
  agents: Agent[],
  idOrHandle: string,
): Agent | undefined {
  return agents.find(
    (agent) =>
      agent.id === idOrHandle ||
      agent.handle === idOrHandle.replace(/^@/, "").toLowerCase(),
  );
}

function agreementLine(text: string): string | undefined {
  const line = text.match(
    /(?:AGREEMENT|RESOLVED|CONSENSUS)\s*[:\-]\s*(.{8,300})/i,
  )?.[1];
  return line?.trim();
}

function negotiationPrompt(
  agent: Agent,
  peer: Agent,
  request: NegotiationRequest,
  round: number,
  transcript: NegotiationMessage[],
  project?: Project,
): string {
  return [
    `AUTONOMOUS PEER NEGOTIATION — round ${round}.`,
    `You are ${agent.name} (${agent.role}). Your peer is ${peer.name} (${peer.role}).`,
    `TOPIC: ${request.topic}`,
    project ? `PROJECT: ${project.name} (${project.stack}) at ${project.workspacePath}` : "",
    request.context ? `CONTEXT:\n${request.context}` : "",
    request.leftArtifact ? `CONTRACT / ARTIFACT A:\n${request.leftArtifact}` : "",
    request.rightArtifact ? `CONTRACT / ARTIFACT B:\n${request.rightArtifact}` : "",
    transcript.length
      ? `NEGOTIATION TRANSCRIPT:\n${transcript
          .map((message) => `${message.fromAgent}: ${message.content}`)
          .join("\n\n")}`
      : "This is the opening round. State the concrete discrepancy you observe.",
    "",
    "Resolve schema, prop or interface conflicts. Be specific and do not invent unrelated requirements.",
    "If you agree, include a line beginning `AGREEMENT:` with a one-sentence decision.",
    "If code must change, emit complete fenced files with `path=` info strings. Never emit diffs.",
    "Keep the response under 900 words.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function say(
  state: NegotiationState,
  round: number,
  from: Agent,
  to: Agent,
  content: string,
): Promise<NegotiationMessage> {
  const message: NegotiationMessage = {
    id: uid("neg"),
    negotiationId: state.id,
    round,
    fromAgent: from.name,
    fromAgentId: from.id,
    toAgent: to.name,
    content,
    createdAt: Date.now(),
  };
  state.messages.push(message);
  persistNegotiations();
  meshBus.publish({
    type: "NEGOTIATION_MESSAGE",
    source: from.name,
    target: to.name,
    agentId: from.id,
    targetAgentId: to.id,
    projectId: state.request.projectId,
    threadId: state.request.threadId,
    severity: "info",
    title: `Peer negotiation · ${from.name} → ${to.name}`,
    message: content.slice(0, 1200),
    payload: { negotiationId: state.id, round, message },
  });
  return message;
}

async function runNegotiation(state: NegotiationState): Promise<void> {
  const request = state.request;
  const agents = await listAgents();
  const left = pickAgent(agents, request.leftAgentId);
  const right = pickAgent(agents, request.rightAgentId);
  if (!left || !right) throw new Error("Both negotiation agents must exist and be configured.");
  if (left.id === right.id) throw new Error("Choose two different agents for peer negotiation.");
  const project = request.projectId ? await getProject(request.projectId) : undefined;
  const maxRounds = Math.min(4, Math.max(1, request.maxRounds ?? 3));

  meshBus.publish({
    type: "NEGOTIATION_STARTED",
    source: left.name,
    target: right.name,
    agentId: left.id,
    targetAgentId: right.id,
    projectId: project?.id,
    threadId: request.threadId,
    severity: "info",
    title: "Autonomous peer negotiation started",
    message: `${left.name} and ${right.name} are reconciling: ${request.topic}`,
    payload: { negotiationId: state.id, maxRounds },
  });

  let agreement: string | undefined;
  let finalArtifacts = "";
  setMeshAgentStatus(left.id, "communicating", `Negotiating with ${right.name}`);
  setMeshAgentStatus(right.id, "communicating", `Negotiating with ${left.name}`);

  for (let round = 1; round <= maxRounds; round += 1) {
    state.rounds = round;
    const leftOutcome = await generateWithAgent({
      agent: left,
      messages: [{ role: "user", content: negotiationPrompt(left, right, request, round, state.messages, project) }],
      purpose: `negotiation · ${request.topic.slice(0, 60)}`,
      projectDir: project?.workspacePath,
      priority: 4,
    });
    await say(state, round, left, right, leftOutcome.result.text);

    const rightOutcome = await generateWithAgent({
      agent: right,
      messages: [{ role: "user", content: negotiationPrompt(right, left, request, round, state.messages, project) }],
      purpose: `negotiation · ${request.topic.slice(0, 60)}`,
      projectDir: project?.workspacePath,
      priority: 4,
    });
    await say(state, round, right, left, rightOutcome.result.text);

    const leftAgreement = agreementLine(leftOutcome.result.text);
    const rightAgreement = agreementLine(rightOutcome.result.text);
    finalArtifacts = `${leftOutcome.result.text}\n\n${rightOutcome.result.text}`;
    if (leftAgreement && rightAgreement) {
      agreement = rightAgreement || leftAgreement;
      break;
    }
  }

  const files = parseFileBlocks(finalArtifacts).filter(
    (file) => !file.path.startsWith("/") && !file.path.includes(".."),
  );
  const appliedFiles: string[] = [];
  if (agreement && request.autoApply && project && files.length) {
    const applied = await applyFileBlocks(project.workspacePath, files);
    appliedFiles.push(...applied.written);
  }

  if (!agreement) {
    const error = `No agreement after ${maxRounds} rounds. The unresolved transcript is retained for operator review.`;
    state.status = "failed";
    state.error = error;
    state.completedAt = Date.now();
    persistNegotiations();
    meshBus.publish({
      type: "NEGOTIATION_FAILED",
      source: left.name,
      target: right.name,
      agentId: left.id,
      targetAgentId: right.id,
      projectId: project?.id,
      threadId: request.threadId,
      severity: "warning",
      title: "Peer negotiation needs an operator",
      message: error,
      payload: { negotiationId: state.id, messages: state.messages, files: files.map((file) => file.path) },
      requiresOverride: true,
    });
    const fileTree = project ? await listWorkspaceFiles(project.workspacePath, 120) : [];
    publishAgentEnvelope({
      from: `@${left.handle.replace(/^@/, "")}`,
      to: `@${right.handle.replace(/^@/, "")}`,
      type: "VALIDATION_REPORT",
      payload: error,
      timestamp: new Date().toISOString(),
      resolutionPath: "Review the retained negotiation transcript, identify the disputed requirement, record a concrete resolution, and restart the handoff with that decision.",
      fileTree,
      workspaceRoot: project?.workspacePath,
      status: "BLOCKED",
    }, { agentId: left.id, targetAgentId: right.id, projectId: project?.id, threadId: request.threadId });
    await appendConstraint({
      agentId: left.id,
      rule: `Peer negotiation stalled on "${request.topic}". Next time, state the concrete schema/prop conflict and an explicit acceptance condition in the first round.`,
      source: "negotiation",
      publish: false,
    });
  } else {
    state.status = "resolved";
    state.agreement = agreement;
    state.appliedFiles = appliedFiles;
    state.completedAt = Date.now();
    persistNegotiations();
    meshBus.publish({
      type: "NEGOTIATION_RESOLVED",
      source: left.name,
      target: right.name,
      agentId: left.id,
      targetAgentId: right.id,
      projectId: project?.id,
      threadId: request.threadId,
      severity: "success",
      title: "Peer negotiation resolved",
      message: `${agreement}${appliedFiles.length ? ` Applied ${appliedFiles.length} reconciled file(s).` : ""}`,
      payload: {
        negotiationId: state.id,
        agreement,
        appliedFiles,
        messages: state.messages,
      },
    });
    await appendConstraint({
      agentId: left.id,
      rule: `When coordinating with ${right.name} on ${request.topic}: ${agreement}`,
      source: "negotiation",
      publish: false,
    });
    await appendConstraint({
      agentId: right.id,
      rule: `When coordinating with ${left.name} on ${request.topic}: ${agreement}`,
      source: "negotiation",
      publish: false,
    });
  }
  setMeshAgentStatus(left.id, "idle", "Negotiation complete");
  setMeshAgentStatus(right.id, "idle", "Negotiation complete");
}

/**
 * Starts a background negotiation and returns immediately. The mesh HUD
 * watches the event stream for the dialogue and resolution.
 */
export function startNegotiation(request: NegotiationRequest): NegotiationState {
  const state: NegotiationState = {
    id: uid("nego"),
    status: "running",
    request,
    messages: [],
    rounds: 0,
    appliedFiles: [],
    startedAt: Date.now(),
  };
  jobs.set(state.id, state);
  persistNegotiations();
  if (jobs.size > 30) {
    const oldest = Array.from(jobs.values())
      .filter((job) => job.status !== "running")
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  void runNegotiation(state).catch(async (error) => {
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    state.completedAt = Date.now();
    persistNegotiations();
    const left = await getAgent(request.leftAgentId).catch(() => undefined);
    const right = await getAgent(request.rightAgentId).catch(() => undefined);
    const project = request.projectId ? await getProject(request.projectId).catch(() => undefined) : undefined;
    const fileTree = project ? await listWorkspaceFiles(project.workspacePath, 120).catch(() => []) : [];
    if (left) {
      const detail = state.error ?? "Negotiation failed.";
      publishAgentEnvelope({
        from: `@${left.handle.replace(/^@/, "")}`,
        to: right ? `@${right.handle.replace(/^@/, "")}` : "@mesh-operator",
        type: "VALIDATION_REPORT",
        payload: detail,
        timestamp: new Date().toISOString(),
        resolutionPath: inferResolutionPath(detail),
        fileTree,
        workspaceRoot: project?.workspacePath,
        status: "FAILED",
      }, { agentId: left.id, targetAgentId: right?.id, projectId: project?.id, threadId: request.threadId });
    }
    meshBus.publish({
      type: "NEGOTIATION_FAILED",
      source: left?.name ?? "Negotiator",
      target: right?.name,
      agentId: left?.id,
      targetAgentId: right?.id,
      projectId: request.projectId,
      threadId: request.threadId,
      severity: "error",
      title: "Peer negotiation failed",
      message: state.error ?? "Negotiation failed.",
      payload: { negotiationId: state.id },
    });
    if (left) setMeshAgentStatus(left.id, "error", state.error);
    if (right) setMeshAgentStatus(right.id, "idle", "Negotiation failed");
  });
  return state;
}

export function getNegotiation(id: string): NegotiationState | undefined {
  return jobs.get(id);
}

export function listNegotiations(): NegotiationState[] {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}
