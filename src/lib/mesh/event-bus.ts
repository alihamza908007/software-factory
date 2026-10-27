import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../db";
import type {
  MeshAgentState,
  MeshAgentStatus,
  MeshEvent,
  MeshEventType,
  MeshSeverity,
} from "../types";
import { uid } from "../utils";

const EVENT_LOG_PATH = path.join(DATA_ROOT, "mesh-events.json");
const PERSIST_DEBOUNCE_MS = 350;

export type MeshEventListener = (event: MeshEvent) => void | Promise<void>;

export interface MeshEventInput {
  type: MeshEventType;
  source: string;
  target?: string;
  agentId?: string;
  targetAgentId?: string;
  threadId?: string;
  projectId?: string;
  runId?: string;
  severity?: MeshSeverity;
  title: string;
  message: string;
  payload?: Record<string, unknown>;
  requiresOverride?: boolean;
}

export interface AgentEnvelope {
  from: string;
  to: string;
  type: "DIRECT_MESSAGE" | "TASK_ASSIGNMENT" | "VALIDATION_REPORT";
  payload: string;
  timestamp: string;
  resolutionPath: string;
  fileTree: string[];
  workspaceRoot?: string;
  status?: "INFO" | "BLOCKED" | "FAILED" | "COMPLETED";
  /** Three-sentence semantic summary and modified-file pointers. */
  summary?: import("../types").HandoffSummary;
}

export function inferResolutionPath(detail: string): string {
  const routeFiles = Array.from(detail.matchAll(/(?:src\/)?app\/(?:[\w()[\]@.-]+\/)*(?:page|route)\.(?:js|jsx|ts|tsx)/gi), (match) => match[0]);
  if (routeFiles.length >= 2) {
    const canonical = [...routeFiles].sort((left, right) => {
      const rank = (file: string) => ({ ".tsx": 4, ".ts": 3, ".jsx": 2, ".js": 1 }[file.slice(file.lastIndexOf("."))] ?? 0);
      return rank(right) - rank(left);
    })[0];
    const duplicates = Array.from(new Set(routeFiles)).filter((file) => file !== canonical);
    return `Merge any needed code into ${canonical}, then remove or move duplicate route file(s) ${duplicates.join(", ")} out of app/ and rerun npm run build.`;
  }
  if (/multiple files.*(route|page)|conflict.*(route|page)|page\.(jsx|tsx).*page\.(jsx|tsx)/i.test(detail)) {
    return "Consolidate duplicate Next.js route files, keep one page/route entry per URL, and rerun npm run build.";
  }
  if (/cannot find module|module not found|missing dependency/i.test(detail)) {
    return "Add the missing dependency to package.json, run npm install, then rerun the failing build or test command.";
  }
  if (/schema\.prisma|prisma.*schema/i.test(detail)) {
    return "Create or correct prisma/schema.prisma, then run npx prisma validate before retrying the handoff.";
  }
  const fileLine = detail.match(/((?:src\/)?(?:app|pages|components|lib|prisma)\/[\w./@()[\]-]+\.(?:[cm]?[jt]sx?|json|prisma))(?::(\d+))?/i);
  if (fileLine) return `Fix ${fileLine[1]}${fileLine[2] ? ` at line ${fileLine[2]}` : ""} using the reported diagnostic, then rerun npm run build.`;
  return "Inspect the exact diagnostic, make the smallest source/configuration fix, then rerun the command that failed and attach its successful output.";
}

interface PersistedMesh {
  version: 1;
  sequence: number;
  events: MeshEvent[];
  statuses: MeshAgentState[];
  updatedAt: number;
}

interface MeshBusState {
  events: MeshEvent[];
  listeners: Map<string, Set<MeshEventListener>>;
  globalListeners: Set<MeshEventListener>;
  statuses: Map<string, MeshAgentState>;
  sequence: number;
  limit: number;
  hydrated: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  writeChain: Promise<void> | null;
}

const globalStore = globalThis as typeof globalThis & {
  __factoryMeshBus?: MeshBusState;
};

function state(): MeshBusState {
  if (!globalStore.__factoryMeshBus) {
    globalStore.__factoryMeshBus = {
      events: [],
      listeners: new Map(),
      globalListeners: new Set(),
      statuses: new Map(),
      sequence: 0,
      limit: 500,
      hydrated: false,
      persistTimer: null,
      writeChain: null,
    };
  }
  return globalStore.__factoryMeshBus;
}

function schedulePersist(): void {
  const store = state();
  if (store.persistTimer) return;
  store.persistTimer = setTimeout(() => {
    store.persistTimer = null;
    const snapshot: PersistedMesh = {
      version: 1,
      sequence: store.sequence,
      events: store.events.slice(-store.limit),
      statuses: Array.from(store.statuses.values()),
      updatedAt: Date.now(),
    };
    store.writeChain = (store.writeChain ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(DATA_ROOT, { recursive: true });
        const tmp = `${EVENT_LOG_PATH}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
        await fs.rename(tmp, EVENT_LOG_PATH);
      })
      .catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Restore the mesh wire after a server restart or dev reload. The registry is
 * local-first and intentionally in-process, so the JSON log is the only source
 * of durable event history. Events published before hydration are merged by id.
 */
export async function hydrateMeshEvents(): Promise<void> {
  const store = state();
  if (store.hydrated) return;
  store.hydrated = true;
  try {
    const raw = await fs.readFile(EVENT_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedMesh>;
    const merged = new Map<string, MeshEvent>();
    for (const event of parsed.events ?? []) {
      if (event?.id) merged.set(event.id, event);
    }
    for (const event of store.events) merged.set(event.id, event);
    store.events = Array.from(merged.values())
      .sort((a, b) => a.at - b.at || (a.sequence ?? 0) - (b.sequence ?? 0))
      .slice(-store.limit);
    store.sequence = Math.max(
      Number(parsed.sequence ?? 0),
      ...store.events.map((event) => Number(event.sequence ?? 0)),
      store.sequence,
    );
    for (const status of parsed.statuses ?? []) {
      if (!status?.agentId) continue;
      const stale =
        status.status === "thinking" ||
        status.status === "communicating" ||
        status.status === "validating" ||
        status.status === "executing";
      store.statuses.set(
        status.agentId,
        stale
          ? {
              ...status,
              status: "idle",
              detail: "Recovered after server restart",
              updatedAt: Date.now(),
            }
          : status,
      );
    }
  } catch {
    // No durable history yet; start clean.
  }
}

function severityFor(type: MeshEventType): MeshSeverity {
  switch (type) {
    case "VALIDATION_PASSED":
    case "POST_FLIGHT_PASSED":
    case "NEGOTIATION_RESOLVED":
    case "AUTOMATION_PASSED":
    case "CANVAS_RUN_COMPLETED":
      return "success";
    case "TEST_FAILED":
    case "SECURITY_WARNING":
    case "VALIDATION_FAILED":
    case "NEGOTIATION_FAILED":
    case "ROUTING_ERROR":
    case "AUTOMATION_FAILED":
    case "PRE_FLIGHT_BLOCKED":
    case "POST_FLIGHT_BLOCKED":
      return "error";
    case "SCHEMA_UPDATED":
    case "VALIDATION_OVERRIDDEN":
    case "SCOPE_ADVISORY":
      return "warning";
    default:
      return "info";
  }
}

/**
 * In-process pub/sub for the agent mesh. Agents publish facts and every other
 * worker subscribes by topic. Delivery is intentionally fire-and-forget: a
 * slow observer can never block an LLM call or the HTTP request that emitted
 * the event.
 */
class MeshEventBus {
  publish(input: MeshEventInput): MeshEvent {
    const store = state();
    const failureEvent =
      input.type === "TEST_FAILED" ||
      input.type === "VALIDATION_FAILED" ||
      input.type === "SECURITY_WARNING" ||
      input.type === "NEGOTIATION_FAILED" ||
      input.type === "AUTOMATION_FAILED" ||
      input.type === "PRE_FLIGHT_BLOCKED" ||
      input.type === "POST_FLIGHT_BLOCKED";
    const payload = failureEvent
      ? {
          ...input.payload,
          resolutionPath: typeof input.payload?.resolutionPath === "string"
            ? input.payload.resolutionPath
            : inferResolutionPath(`${input.title}\n${input.message}`),
          fileTree: Array.isArray(input.payload?.fileTree) ? input.payload.fileTree : [],
        }
      : input.payload;
    store.sequence += 1;
    const event: MeshEvent = {
      ...input,
      payload,
      id: uid("mesh"),
      sequence: store.sequence,
      at: Date.now(),
      severity: input.severity ?? severityFor(input.type),
      title: input.title,
      message: input.message,
    };
    store.events.push(event);
    if (store.events.length > store.limit) {
      store.events.splice(0, store.events.length - store.limit);
    }
    schedulePersist();

    if (input.type === "AGENT_STATUS" && input.agentId) {
      const detail =
        typeof input.payload?.detail === "string" ? input.payload.detail : input.message;
      this.setAgentStatus(
        input.agentId,
        (input.payload?.status as MeshAgentStatus | undefined) ?? "idle",
        detail,
      );
    }

    const listeners = [
      ...(store.listeners.get(input.type) ?? []),
      ...store.globalListeners,
    ];
    for (const listener of listeners) {
      queueMicrotask(() => {
        try {
          void Promise.resolve(listener(event)).catch(() => undefined);
        } catch {
          // A broken subscriber must never break the mesh.
        }
      });
    }
    return event;
  }

  subscribe(type: MeshEventType, listener: MeshEventListener): () => void {
    const store = state();
    const listeners = store.listeners.get(type) ?? new Set<MeshEventListener>();
    listeners.add(listener);
    store.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) store.listeners.delete(type);
    };
  }

  subscribeAll(listener: MeshEventListener): () => void {
    const store = state();
    store.globalListeners.add(listener);
    return () => store.globalListeners.delete(listener);
  }

  setAgentStatus(
    agentId: string,
    status: MeshAgentStatus,
    detail?: string,
  ): MeshAgentState {
    const store = state();
    const next: MeshAgentState = {
      agentId,
      status,
      detail,
      updatedAt: Date.now(),
    };
    store.statuses.set(agentId, next);
    schedulePersist();
    return next;
  }

  statuses(): MeshAgentState[] {
    return Array.from(state().statuses.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  sequenceNumber(): number {
    return state().sequence;
  }

  /** Events strictly newer than a client sequence, used for cheap resume. */
  since(sequence: number, limit = 200): MeshEvent[] {
    return state()
      .events.filter((event) => (event.sequence ?? 0) > sequence)
      .slice(-limit);
  }

  status(agentId: string): MeshAgentState {
    return (
      state().statuses.get(agentId) ?? {
        agentId,
        status: "idle",
        updatedAt: 0,
      }
    );
  }

  backlog(limit = 120): MeshEvent[] {
    const events = state().events;
    return events.slice(Math.max(0, events.length - limit));
  }

  recent(limit = 20): MeshEvent[] {
    return this.backlog(limit);
  }

  clear(): void {
    const store = state();
    store.events = [];
    store.statuses.clear();
    schedulePersist();
  }
}

export const meshBus = new MeshEventBus();

export function publishMeshEvent(input: MeshEventInput): MeshEvent {
  return meshBus.publish(input);
}

export function publishAgentEnvelope(
  envelope: AgentEnvelope,
  context: Pick<MeshEventInput, "agentId" | "targetAgentId" | "threadId" | "projectId" | "runId"> = {},
): MeshEvent {
  if (!envelope.resolutionPath.trim()) throw new Error("Agent envelopes require a resolutionPath.");
  if (!Array.isArray(envelope.fileTree)) throw new Error("Agent envelopes require a fileTree snapshot.");
  return meshBus.publish({
    ...context,
    type: "AGENT_ENVELOPE",
    source: envelope.from,
    target: envelope.to,
    title: `${envelope.type.replaceAll("_", " ")}: ${envelope.from} → ${envelope.to}`,
    message: envelope.status === "FAILED" || envelope.status === "BLOCKED"
      ? `${envelope.payload}\n\nResolution path: ${envelope.resolutionPath}`
      : envelope.payload,
    payload: {
      envelope,
      summary: envelope.summary,
      resolutionPath: envelope.resolutionPath,
      fileTree: envelope.fileTree,
      workspaceRoot: envelope.workspaceRoot,
    },
  });
}

/**
 * Agents report out-of-scope discoveries on a dedicated line so the advisory
 * is visible to the operator without interrupting the current task.
 */
export function publishScopeAdvisories(
  source: string,
  text: string,
  context: Pick<MeshEventInput, "agentId" | "threadId" | "projectId" | "runId"> = {},
): MeshEvent[] {
  const advisories = Array.from(text.matchAll(/^\s*SCOPE_ADVISORY\s*:\s*(.+)$/gim), (match) => match[1].trim())
    .filter(Boolean)
    .slice(0, 8);
  return advisories.map((advisory) =>
    meshBus.publish({
      ...context,
      type: "SCOPE_ADVISORY",
      source,
      severity: "warning",
      title: `Out-of-scope advisory · ${source}`,
      message: advisory,
      payload: { advisory, scope: "advisory-only" },
    }),
  );
}

export function setMeshAgentStatus(
  agentId: string,
  status: MeshAgentStatus,
  detail?: string,
): MeshAgentState {
  meshBus.setAgentStatus(agentId, status, detail);
  return meshBus.status(agentId);
}
