import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../db";
import type {
  Agent,
  AgentConstraint,
  AgentHandoffMemory,
  AgentMemory,
  GuardrailResult,
} from "../types";
import { uid } from "../utils";
import { meshBus } from "./event-bus";

const MEMORY_PATH = path.join(DATA_ROOT, "mesh-memory.json");
const MAX_CONSTRAINTS_PER_AGENT = 24;
const MAX_HANDOFFS_PER_AGENT = 12;
const MAX_EVIDENCE_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 1_200;

interface MemoryFile {
  version: 1;
  agents: Record<string, AgentMemory>;
  updatedAt: number;
}

interface MemoryGlobal {
  __factoryAgentMemory?: MemoryFile;
  __factoryAgentMemoryWrite?: Promise<void>;
}

const globalStore = globalThis as typeof globalThis & MemoryGlobal;
let loadPromise: Promise<MemoryFile> | undefined;

function fresh(): MemoryFile {
  return { version: 1, agents: {}, updatedAt: Date.now() };
}

function normaliseRule(rule: string): string {
  return rule.replace(/\s+/g, " ").replace(/^[-*]\s*/, "").trim().slice(0, 360);
}

function dedupeKey(rule: string): string {
  return normaliseRule(rule).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function load(): Promise<MemoryFile> {
  if (globalStore.__factoryAgentMemory) return globalStore.__factoryAgentMemory;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(MEMORY_PATH, "utf8");
        const parsed = JSON.parse(raw) as Partial<MemoryFile>;
        const file: MemoryFile = {
          version: 1,
          agents: parsed.agents ?? {},
          updatedAt: parsed.updatedAt ?? Date.now(),
        };
        globalStore.__factoryAgentMemory = file;
        return file;
      } catch {
        const file = fresh();
        globalStore.__factoryAgentMemory = file;
        return file;
      }
    })();
  }
  return loadPromise;
}

async function persist(file: MemoryFile): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  file.updatedAt = Date.now();
  const tmp = `${MEMORY_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await fs.rename(tmp, MEMORY_PATH);
}

async function mutate<T>(fn: (file: MemoryFile) => T | Promise<T>): Promise<T> {
  const file = await load();
  const result = await fn(file);
  globalStore.__factoryAgentMemoryWrite = (
    globalStore.__factoryAgentMemoryWrite ?? Promise.resolve()
  )
    .catch(() => undefined)
    .then(() => persist(file));
  await globalStore.__factoryAgentMemoryWrite;
  return result;
}

export async function listAgentMemory(agentId?: string): Promise<AgentMemory[]> {
  const file = await load();
  const records = Object.values(file.agents);
  return (agentId ? records.filter((record) => record.agentId === agentId) : records).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export async function getAgentConstraints(
  agentId: string,
  limit = MAX_CONSTRAINTS_PER_AGENT,
): Promise<AgentConstraint[]> {
  const memory = (await load()).agents[agentId];
  return (memory?.constraints ?? []).slice(-limit);
}

export async function appendConstraint(input: {
  agentId: string;
  agentName?: string;
  rule: string;
  source: AgentConstraint["source"];
  evidence?: string;
  publish?: boolean;
}): Promise<AgentConstraint | undefined> {
  const rule = normaliseRule(input.rule);
  if (rule.length < 8) return undefined;
  const key = dedupeKey(rule);
  let appended: AgentConstraint | undefined;

  await mutate((file) => {
    const now = Date.now();
    const record: AgentMemory =
      file.agents[input.agentId] ??
      { agentId: input.agentId, constraints: [], updatedAt: now };
    const existing = record.constraints.find((constraint) => dedupeKey(constraint.rule) === key);
    if (existing) {
      existing.hits += 1;
      existing.createdAt = now;
      existing.evidence = input.evidence?.slice(-MAX_EVIDENCE_CHARS) ?? existing.evidence;
      record.constraints = record.constraints.filter((constraint) => constraint.id !== existing.id);
      record.constraints.push(existing);
      record.updatedAt = now;
      file.agents[input.agentId] = record;
      appended = existing;
      return;
    }
    const constraint: AgentConstraint = {
      id: uid("mem"),
      agentId: input.agentId,
      rule,
      source: input.source,
      evidence: input.evidence?.slice(-MAX_EVIDENCE_CHARS),
      createdAt: now,
      hits: 1,
    };
    record.constraints.push(constraint);
    if (record.constraints.length > MAX_CONSTRAINTS_PER_AGENT) {
      record.constraints = record.constraints.slice(-MAX_CONSTRAINTS_PER_AGENT);
    }
    record.updatedAt = now;
    file.agents[input.agentId] = record;
    appended = constraint;
  });

  if (appended && input.publish !== false) {
    meshBus.publish({
      type: "MEMORY_CONSTRAINT",
      source: "Epigenetic Memory",
      agentId: input.agentId,
      targetAgentId: input.agentId,
      severity: "info",
      title: `${input.agentName ?? "Agent"} learned a constraint`,
      message: appended.rule,
      payload: { constraint: appended, source: input.source },
    });
  }
  return appended;
}

/**
 * Persist only the semantic handoff summary and workspace pointers. Raw file
 * contents belong to the ephemeral scratchpad and must be purged when the task
 * contract completes.
 */
export async function appendHandoffMemory(input: {
  agentId: string;
  taskId: string;
  summary: string;
  modifiedFiles: string[];
}): Promise<AgentHandoffMemory | undefined> {
  const summary = input.summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return undefined;
  const files = Array.from(new Set(input.modifiedFiles.map((file) => file.trim()).filter(Boolean))).slice(0, 24);
  let appended: AgentHandoffMemory | undefined;

  await mutate((file) => {
    const now = Date.now();
    const record: AgentMemory =
      file.agents[input.agentId] ??
      { agentId: input.agentId, constraints: [], handoffs: [], updatedAt: now };
    const handoffs = (record.handoffs ?? []).filter((entry) => entry.taskId !== input.taskId);
    const entry: AgentHandoffMemory = {
      id: uid("handoff"),
      agentId: input.agentId,
      taskId: input.taskId,
      summary,
      modifiedFiles: files,
      createdAt: now,
    };
    handoffs.push(entry);
    record.handoffs = handoffs.slice(-MAX_HANDOFFS_PER_AGENT);
    record.updatedAt = now;
    file.agents[input.agentId] = record;
    appended = entry;
  });

  return appended;
}

export async function learnFromFailure(input: {
  agent: Pick<Agent, "id" | "name" | "handle" | "role">;
  source: AgentConstraint["source"];
  detail: string;
  verdict?: GuardrailResult;
}): Promise<AgentConstraint | undefined> {
  const clean = input.detail.replace(/\s+/g, " ").trim().slice(0, 260);
  const checks = input.verdict?.checks
    .filter((check) => check.level !== "pass")
    .map((check) => check.label)
    .slice(0, 3);
  const rule = [
    `Before completing future ${input.agent.role} handoffs, verify ${checks?.length ? checks.join(", ") : "the output contract"}.`,
    clean ? `Prior failure: ${clean}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return appendConstraint({
    agentId: input.agent.id,
    agentName: input.agent.name,
    rule,
    source: input.source,
    evidence: input.detail,
  });
}

export async function clearAgentMemory(agentId?: string): Promise<void> {
  await mutate((file) => {
    if (agentId) delete file.agents[agentId];
    else file.agents = {};
  });
}

export async function buildMemoryPrompt(
  agentId: string,
  limit = 8,
): Promise<string | undefined> {
  const memory = (await load()).agents[agentId];
  const constraints = (memory?.constraints ?? [])
    .slice()
    .sort((a, b) => (b.hits ?? 1) - (a.hits ?? 1) || b.createdAt - a.createdAt)
    .slice(0, limit);
  const handoffs = (memory?.handoffs ?? []).slice(-3);
  if (!constraints.length && !handoffs.length) return undefined;
  const evidenceByConstraint = new Map(
    constraints.slice(-2).map((constraint) => [constraint.id, constraint.evidence?.slice(-1_200)]),
  );
  const lines = [
    "EPIGENETIC MEMORY — rules learned from your previous failures in this factory:",
    ...constraints.map((constraint, index) => {
      const evidence = evidenceByConstraint.get(constraint.id);
      return `${index + 1}. ${constraint.rule}${evidence ? `\n   Recent terminal evidence: ${evidence}` : ""}`;
    }),
    "Treat these as hard constraints. Do not repeat the mistakes that created them.",
  ];
  if (handoffs.length) {
    lines.push(
      "",
      "RECENT COMPLETED HANDOFFS — semantic summary and file pointers only:",
      ...handoffs.map((handoff, index) => {
        const pointers = handoff.modifiedFiles.length ? handoff.modifiedFiles.slice(0, 8).join(", ") : "no workspace files";
        return `${index + 1}. ${handoff.summary}\n   Files: ${pointers}`;
      }),
    );
  }
  return lines.join("\n");
}

/**
 * Inject learned rules into the first system message. This is centralised in
 * the provider router so chat, SDLC phases, canvas nodes and background
 * negotiators all inherit the same self-improving memory.
 */
export async function injectAgentMemory(
  agentId: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
  const memory = await buildMemoryPrompt(agentId);
  if (!memory) return messages;
  const firstSystem = messages.findIndex((message) => message.role === "system");
  if (firstSystem >= 0) {
    return messages.map((message, index) =>
      index === firstSystem
        ? { ...message, content: `${message.content}\n\n${memory}` }
        : message,
    );
  }
  return [{ role: "system" as const, content: memory }, ...messages];
}

export async function memorySummary(agentId: string): Promise<string | undefined> {
  const memory = (await load()).agents[agentId];
  if (!memory?.constraints.length && !memory?.handoffs?.length) return undefined;
  const constraints = (memory?.constraints ?? [])
    .slice(-5)
    .map((constraint) => `- ${constraint.rule}`);
  const handoffs = (memory?.handoffs ?? [])
    .slice(-3)
    .map((handoff) => `- Completed handoff: ${handoff.summary} (${handoff.modifiedFiles.length} file pointer${handoff.modifiedFiles.length === 1 ? "" : "s"})`);
  return [...constraints, ...handoffs].join("\n");
}
