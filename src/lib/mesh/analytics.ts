import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../db";
import type { Agent, AgentAnalytics, MeshEvent } from "../types";
import { meshBus } from "./event-bus";

const ANALYTICS_PATH = path.join(DATA_ROOT, "agent-analytics.json");
const PERSIST_DEBOUNCE_MS = 400;
const MAX_TRACKED_TASKS = 500;
const MAX_PROCESSED_EVENTS = 1_200;

interface AgentStats {
  agentId: string;
  tasksAssigned: number;
  accepted: number;
  rejected: number;
  blocked: number;
  postFlightPassed: number;
  postFlightFailed: number;
  postFlightAttempts: number;
  firstPasses: number;
  tokensConsumed: number;
  artifacts: Map<string, number>;
  lastActivityAt: number;
}

interface TaskState {
  agentId: string;
  assigned: boolean;
  accepted: boolean;
  rejected: boolean;
  blocked: boolean;
  postFlightAttempts: number;
  completed: boolean;
}

interface PersistedAnalytics {
  version: 1;
  agents: Record<string, Omit<AgentStats, "artifacts"> & { artifacts: Record<string, number> }>;
  tasks: Record<string, TaskState>;
  processedEvents: string[];
  updatedAt: number;
}

interface AnalyticsState {
  agents: Map<string, AgentStats>;
  tasks: Map<string, TaskState>;
  processedEvents: Set<string>;
  loaded: boolean;
  loading?: Promise<void>;
  subscribed: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  writeChain: Promise<void> | null;
}

interface AnalyticsGlobal {
  __factoryAnalytics?: AnalyticsState;
}

const globalStore = globalThis as typeof globalThis & AnalyticsGlobal;

function state(): AnalyticsState {
  return (globalStore.__factoryAnalytics ??= {
    agents: new Map(),
    tasks: new Map(),
    processedEvents: new Set(),
    loaded: false,
    subscribed: false,
    persistTimer: null,
    writeChain: null,
  });
}

function emptyAgent(agentId: string): AgentStats {
  return {
    agentId,
    tasksAssigned: 0,
    accepted: 0,
    rejected: 0,
    blocked: 0,
    postFlightPassed: 0,
    postFlightFailed: 0,
    postFlightAttempts: 0,
    firstPasses: 0,
    tokensConsumed: 0,
    artifacts: new Map<string, number>(),
    lastActivityAt: 0,
  };
}

function agentStats(agentId: string): AgentStats {
  const existing = state().agents.get(agentId);
  if (existing) return existing;
  const created = emptyAgent(agentId);
  state().agents.set(agentId, created);
  return created;
}

async function load(): Promise<void> {
  const store = state();
  if (store.loaded) return;
  if (store.loading) return store.loading;
  store.loading = (async () => {
    try {
      const raw = await fs.readFile(ANALYTICS_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedAnalytics>;
      for (const [agentId, record] of Object.entries(parsed.agents ?? {})) {
        if (!record || typeof record !== "object") continue;
        const stats = agentStats(agentId);
        stats.tasksAssigned = Number(record.tasksAssigned ?? 0);
        stats.accepted = Number(record.accepted ?? 0);
        stats.rejected = Number(record.rejected ?? 0);
        stats.blocked = Number(record.blocked ?? 0);
        stats.postFlightPassed = Number(record.postFlightPassed ?? 0);
        stats.postFlightFailed = Number(record.postFlightFailed ?? 0);
        stats.postFlightAttempts = Number(record.postFlightAttempts ?? 0);
        stats.firstPasses = Number(record.firstPasses ?? 0);
        stats.tokensConsumed = Number(record.tokensConsumed ?? 0);
        stats.lastActivityAt = Number(record.lastActivityAt ?? 0);
        for (const [file, bytes] of Object.entries(record.artifacts ?? {})) {
          stats.artifacts.set(file, Number(bytes ?? 0));
        }
      }
      for (const [taskId, task] of Object.entries(parsed.tasks ?? {})) {
        if (!task || typeof task !== "object") continue;
        store.tasks.set(taskId, {
          agentId: String(task.agentId ?? ""),
          assigned: Boolean(task.assigned),
          accepted: Boolean(task.accepted),
          rejected: Boolean(task.rejected),
          blocked: Boolean(task.blocked),
          postFlightAttempts: Number(task.postFlightAttempts ?? 0),
          completed: Boolean(task.completed),
        });
      }
      store.processedEvents = new Set(Array.isArray(parsed.processedEvents) ? parsed.processedEvents : []);
    } catch {
      // Analytics starts empty when no previous run exists.
    } finally {
      store.loaded = true;
      store.loading = undefined;
    }
  })();
  return store.loading;
}

function schedulePersist(): void {
  const store = state();
  if (store.persistTimer) return;
  store.persistTimer = setTimeout(() => {
    store.persistTimer = null;
    const snapshot: PersistedAnalytics = {
      version: 1,
      agents: Object.fromEntries(
        Array.from(store.agents.entries()).map(([agentId, stats]) => [
          agentId,
          {
            ...stats,
            artifacts: Object.fromEntries(stats.artifacts),
          },
        ]),
      ),
      tasks: Object.fromEntries(
        Array.from(store.tasks.entries()).slice(-MAX_TRACKED_TASKS),
      ),
      processedEvents: Array.from(store.processedEvents).slice(-MAX_PROCESSED_EVENTS),
      updatedAt: Date.now(),
    };
    store.writeChain = (store.writeChain ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(DATA_ROOT, { recursive: true });
        const tmp = `${ANALYTICS_PATH}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
        await fs.rename(tmp, ANALYTICS_PATH);
      })
      .catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
}

function taskState(taskId: string, agentId: string): TaskState {
  const store = state();
  const existing = store.tasks.get(taskId);
  if (existing) return existing;
  const created: TaskState = {
    agentId,
    assigned: false,
    accepted: false,
    rejected: false,
    blocked: false,
    postFlightAttempts: 0,
    completed: false,
  };
  store.tasks.set(taskId, created);
  if (store.tasks.size > MAX_TRACKED_TASKS) {
    const first = store.tasks.keys().next().value;
    if (first) store.tasks.delete(first);
  }
  return created;
}

function touch(stats: AgentStats): void {
  stats.lastActivityAt = Date.now();
}

function handleEvent(event: MeshEvent): void {
  const store = state();
  if (store.processedEvents.has(event.id)) return;
  store.processedEvents.add(event.id);
  if (store.processedEvents.size > MAX_PROCESSED_EVENTS) {
    const first = store.processedEvents.values().next().value;
    if (first) store.processedEvents.delete(first);
  }

  if (event.type === "TASK_CONTRACT") {
    const contract = event.payload?.contract as
      | { taskId?: unknown; status?: unknown; targetAgent?: unknown }
      | undefined;
    const taskId = typeof contract?.taskId === "string" ? contract.taskId : undefined;
    const agentId = event.agentId;
    if (!taskId || !agentId) return;
    const stats = agentStats(agentId);
    const task = taskState(taskId, agentId);
    if (!task.assigned) {
      task.assigned = true;
      stats.tasksAssigned += 1;
    }
    const status = typeof contract?.status === "string" ? contract.status : "";
    if ((status === "ACCEPTED" || status === "COMPLETED") && !task.accepted) {
      task.accepted = true;
      stats.accepted += 1;
    } else if (status === "REJECTED" && !task.rejected) {
      task.rejected = true;
      stats.rejected += 1;
    } else if (status === "BLOCKED" && !task.blocked) {
      task.blocked = true;
      stats.blocked += 1;
    }
    touch(stats);
    schedulePersist();
    return;
  }

  if (event.type === "POST_FLIGHT_BLOCKED" || event.type === "POST_FLIGHT_PASSED") {
    if (event.payload?.analyticsRecorded === true) return;
    const agentId = event.agentId;
    if (!agentId) return;
    const contract = event.payload?.contract as { taskId?: unknown } | undefined;
    const taskId = typeof contract?.taskId === "string" ? contract.taskId : `event:${event.id}`;
    const stats = agentStats(agentId);
    const task = taskState(taskId, agentId);
    task.postFlightAttempts += 1;
    stats.postFlightAttempts += 1;
    if (event.type === "POST_FLIGHT_BLOCKED") {
      stats.postFlightFailed += 1;
      task.blocked = true;
    } else {
      stats.postFlightPassed += 1;
      if (task.postFlightAttempts === 1) stats.firstPasses += 1;
      task.completed = true;
    }
    touch(stats);
    schedulePersist();
    return;
  }

  if (event.type === "ARTIFACT_CREATED") {
    const agentId = event.agentId;
    if (!agentId) return;
    const files = event.payload?.files;
    if (!Array.isArray(files)) return;
    const stats = agentStats(agentId);
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const record = file as Record<string, unknown>;
      if (typeof record.path !== "string") continue;
      const content = typeof record.content === "string" ? record.content : "";
      stats.artifacts.set(record.path.replace(/\\/g, "/"), Buffer.byteLength(content, "utf8"));
    }
    touch(stats);
    schedulePersist();
  }
}

function ingestBacklog(): void {
  for (const event of meshBus.backlog(400)) handleEvent(event);
}

function subscribe(): void {
  const store = state();
  if (store.subscribed) return;
  store.subscribed = true;
  meshBus.subscribeAll((event) => {
    handleEvent(event);
  });
}

function ensureRuntime(): void {
  subscribe();
  ingestBacklog();
}

/** Hydrate persisted counters, ingest durable mesh events, and subscribe once. */
export function ensureAnalyticsRuntime(): void {
  void load().then(() => ensureRuntime()).catch(() => undefined);
}

export async function recordTokenUsage(agentId: string, tokens: number): Promise<void> {
  if (!agentId || !Number.isFinite(tokens) || tokens <= 0) return;
  await load();
  ensureRuntime();
  const stats = agentStats(agentId);
  stats.tokensConsumed += Math.round(tokens);
  touch(stats);
  schedulePersist();
}

export async function recordContribution(
  agentId: string,
  files: Array<{ path: string; bytes?: number; content?: string }>,
): Promise<void> {
  if (!agentId || !files.length) return;
  await load();
  ensureRuntime();
  const stats = agentStats(agentId);
  for (const file of files) {
    if (!file.path) continue;
    const bytes = Number.isFinite(file.bytes) ? Number(file.bytes) : Buffer.byteLength(file.content ?? "", "utf8");
    stats.artifacts.set(file.path.replace(/\\/g, "/"), Math.max(0, bytes));
  }
  touch(stats);
  schedulePersist();
}

export async function recordPostFlightResult(
  agentId: string,
  taskId: string,
  passed: boolean,
): Promise<void> {
  if (!agentId) return;
  await load();
  ensureRuntime();
  const stats = agentStats(agentId);
  const task = taskState(taskId || `anonymous:${Date.now()}`, agentId);
  task.postFlightAttempts += 1;
  stats.postFlightAttempts += 1;
  if (passed) {
    stats.postFlightPassed += 1;
    if (task.postFlightAttempts === 1) stats.firstPasses += 1;
    task.completed = true;
  } else {
    stats.postFlightFailed += 1;
    task.blocked = true;
  }
  touch(stats);
  schedulePersist();
}

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export async function getAgentAnalytics(agents: Agent[]): Promise<AgentAnalytics[]> {
  await load();
  ensureRuntime();
  return agents
    .filter((agent) => agent.enabled)
    .map((agent) => {
      const stats = agentStats(agent.id);
      const artifacts = Array.from(stats.artifacts.entries());
      return {
        agentId: agent.id,
        name: agent.name,
        handle: `@${agent.handle.replace(/^@/, "")}`,
        enabled: agent.enabled,
        tasksAssigned: stats.tasksAssigned,
        accepted: stats.accepted,
        rejected: stats.rejected,
        blocked: stats.blocked,
        acceptanceRate: percent(stats.accepted, stats.accepted + stats.rejected),
        postFlightPassed: stats.postFlightPassed,
        postFlightFailed: stats.postFlightFailed,
        postFlightAttempts: stats.postFlightAttempts,
        firstPasses: stats.firstPasses,
        firstPassRate: percent(stats.firstPasses, stats.postFlightPassed),
        tokensConsumed: stats.tokensConsumed,
        artifactFiles: artifacts.length,
        artifactBytes: artifacts.reduce((sum, [, bytes]) => sum + bytes, 0),
        artifactPaths: artifacts.map(([file]) => file).sort().slice(0, 24),
        lastActivityAt: stats.lastActivityAt,
      };
    })
    .sort((a, b) => b.postFlightPassed - a.postFlightPassed || b.tasksAssigned - a.tasksAssigned || a.name.localeCompare(b.name));
}
