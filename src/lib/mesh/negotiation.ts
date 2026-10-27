import type { Agent, NegotiationMessage } from "../types";
import { uid } from "../utils";
import {
  agentCapabilities,
  capabilityScore,
  inferRequiredCapabilities,
} from "./accountability";
import { meshBus } from "./event-bus";
import { recordTaskNegotiation, type NegotiationState } from "./negotiator";

export interface TaskNegotiationInput {
  objective: string;
  agents: Agent[];
  projectId?: string;
  threadId?: string;
  runId?: string;
  managerId?: string;
  /** Maximum candidate bids retained per domain (default 3). */
  maxBidsPerDomain?: number;
}

export interface TaskOwnershipAssignment {
  agentId: string;
  agentName: string;
  handle: `@${string}`;
  lanes: string[];
  score: number;
  objective: string;
}

export interface TaskNegotiationResult {
  negotiated: boolean;
  multiDomain: boolean;
  id?: string;
  lanes: string[];
  assignments: TaskOwnershipAssignment[];
  transcript: NegotiationMessage[];
  agreement: string;
  savedAt?: number;
}

function handleFor(agent: Agent): `@${string}` {
  return `@${agent.handle.replace(/^@/, "")}` as const;
}

function scopedObjective(objective: string, agent: Agent, lanes: string[]): string {
  return [
    objective.trim(),
    "",
    `NEGOTIATED SCOPE — ${agent.name} owns only: ${lanes.join(", ")}.`,
    "Do not duplicate or overwrite another owner's domain. Return pointer-based artifacts and report cross-domain discoveries as advisory notes instead of expanding scope.",
  ].join("\n");
}

function managerFor(agents: Agent[], managerId?: string): Agent | undefined {
  return (
    agents.find((agent) => agent.id === managerId && agent.enabled) ??
    agents.find((agent) => agent.enabled && /product|manager|supervisor/i.test(`${agent.name} ${agent.role}`))
  );
}

/**
 * One-turn task ownership negotiation. Candidate agents bid against their
 * capability scores; the orchestrator records the transcript, assigns distinct
 * domain lanes where possible, and persists the decision before execution.
 */
export async function negotiateTaskOwnership(
  input: TaskNegotiationInput,
): Promise<TaskNegotiationResult> {
  const objective = input.objective.trim();
  const enabled = input.agents.filter((agent) => agent.enabled);
  const lanes = inferRequiredCapabilities(objective);
  const multiDomain = lanes.length > 1;
  if (!objective || !enabled.length || !multiDomain) {
    return {
      negotiated: false,
      multiDomain,
      lanes,
      assignments: [],
      transcript: [],
      agreement: "",
    };
  }

  const manager = managerFor(enabled, input.managerId);
  const maxBids = Math.max(1, Math.min(6, input.maxBidsPerDomain ?? 3));
  const used = new Set<string>();
  const assignments = new Map<string, TaskOwnershipAssignment>();
  const transcript: NegotiationMessage[] = [];
  const negotiationId = uid("nego");
  const startedAt = Date.now();

  const say = (
    from: Agent | undefined,
    to: Agent | undefined,
    content: string,
  ) => {
    transcript.push({
      id: uid("neg"),
      negotiationId,
      round: 1,
      fromAgent: from?.name ?? "Orchestrator",
      fromAgentId: from?.id ?? "orchestrator",
      toAgent: to?.name ?? "Task owners",
      content,
      createdAt: Date.now(),
    });
  };

  say(
    manager,
    undefined,
    `NEGOTIATION OPEN: "${objective.slice(0, 280)}" spans ${lanes.join(", ")}. Candidate agents must bid only for domains inside their registered capabilities.`,
  );

  for (const lane of lanes) {
    const ranked = enabled
      .map((agent) => ({ agent, score: capabilityScore(agent, [lane]), capabilities: agentCapabilities(agent) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    const candidates = ranked.length ? ranked : enabled.map((agent) => ({ agent, score: 0, capabilities: agentCapabilities(agent) }));
    for (const candidate of candidates.slice(0, maxBids)) {
      const competing = candidates.find((item) => item.agent.id !== candidate.agent.id && item.score > candidate.score);
      say(
        candidate.agent,
        manager,
        competing
          ? `BID: I can support ${lane} at ${Math.round(candidate.score * 100)}%, but ${competing.agent.name} has the stronger match (${Math.round(competing.score * 100)}%). I will not duplicate ownership unless reassigned.`
          : `BID: I will own ${lane} at ${Math.round(candidate.score * 100)}% capability alignment. I will return pointer-based artifacts and pass the post-flight gate before handoff.`,
      );
    }
  }

  for (const lane of lanes) {
    const ranked = enabled
      .map((agent) => ({ agent, score: capabilityScore(agent, [lane]) }))
      .sort((left, right) => right.score - left.score || Number(left.agent.id === manager?.id) - Number(right.agent.id === manager?.id));
    const distinct = ranked.find((candidate) => candidate.score > 0 && !used.has(candidate.agent.id));
    const chosen = distinct ?? ranked.find((candidate) => candidate.score > 0) ?? ranked[0];
    if (!chosen) continue;
    used.add(chosen.agent.id);
    const existing = assignments.get(chosen.agent.id);
    if (existing) {
      existing.lanes.push(lane);
      existing.score = Math.min(existing.score, chosen.score);
      existing.objective = scopedObjective(objective, chosen.agent, existing.lanes);
    } else {
      assignments.set(chosen.agent.id, {
        agentId: chosen.agent.id,
        agentName: chosen.agent.name,
        handle: handleFor(chosen.agent),
        lanes: [lane],
        score: chosen.score,
        objective: scopedObjective(objective, chosen.agent, [lane]),
      });
    }
  }

  const assigned = Array.from(assignments.values()).sort((left, right) => right.score - left.score);
  const agreement = assigned.length
    ? `${manager?.name ?? "Orchestrator"} assigns ${assigned
        .map((assignment) => `${assignment.lanes.join(" + ")} to ${assignment.handle}`)
        .join("; ")}. Each owner works only inside the negotiated scope and returns a post-flight summary.`
    : "No enabled agent has a matching capability; the objective must be split or a new specialist registered.";

  say(manager, assigned[0] ? enabled.find((agent) => agent.id === assigned[0].agentId) : undefined, `AGREEMENT: ${agreement}`);

  const state: NegotiationState = {
    id: negotiationId,
    status: "resolved",
    request: {
      leftAgentId: manager?.id ?? assigned[0]?.agentId ?? enabled[0].id,
      rightAgentId: assigned.find((assignment) => assignment.agentId !== manager?.id)?.agentId ?? assigned[0]?.agentId ?? enabled[0].id,
      topic: `Task ownership: ${objective.slice(0, 400)}`,
      context: `Lanes: ${lanes.join(", ")}. Transcript persisted before execution.`,
      projectId: input.projectId,
      threadId: input.threadId,
      maxRounds: 1,
      autoApply: false,
    },
    messages: transcript,
    rounds: 1,
    agreement,
    appliedFiles: [],
    startedAt,
    completedAt: Date.now(),
  };

  // Durability is part of the contract: no execution before the audit record
  // reaches .data/negotiations.json.
  await recordTaskNegotiation(state);

  meshBus.publish({
    type: "NEGOTIATION_STARTED",
    source: manager?.name ?? "Orchestrator",
    target: assigned.map((assignment) => assignment.handle).join(", "),
    agentId: manager?.id,
    projectId: input.projectId,
    threadId: input.threadId,
    runId: input.runId,
    severity: "info",
    title: "Task ownership negotiation started",
    message: `${lanes.length} domains detected; ${enabled.length} candidate agent(s) bidding.`,
    payload: { negotiationId, lanes, multiDomain: true },
  });
  for (const message of transcript) {
    meshBus.publish({
      type: "NEGOTIATION_MESSAGE",
      source: message.fromAgent,
      target: message.toAgent,
      projectId: input.projectId,
      threadId: input.threadId,
      runId: input.runId,
      severity: "info",
      title: `Task negotiation · ${message.fromAgent} → ${message.toAgent}`,
      message: message.content.slice(0, 1_200),
      payload: { negotiationId, round: 1, message },
    });
  }
  meshBus.publish({
    type: "NEGOTIATION_RESOLVED",
    source: manager?.name ?? "Orchestrator",
    target: assigned.map((assignment) => assignment.handle).join(", "),
    agentId: manager?.id,
    projectId: input.projectId,
    threadId: input.threadId,
    runId: input.runId,
    severity: "success",
    title: "Task ownership negotiated",
    message: agreement,
    payload: { negotiationId, agreement, assignments: assigned, messages: transcript },
  });

  return {
    negotiated: true,
    multiDomain: true,
    id: negotiationId,
    lanes,
    assignments: assigned,
    transcript,
    agreement,
    savedAt: state.completedAt,
  };
}
