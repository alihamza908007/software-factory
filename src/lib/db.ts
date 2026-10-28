import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, defaultAgents } from "./constants";
import type {
  Agent,
  AgentMetric,
  CanvasTopology,
  ChatMessage,
  ChatThread,
  FactoryDb,
  FactorySettings,
  Project,
  Run,
} from "./types";

export const DATA_ROOT = process.env.FACTORY_DATA_ROOT
  ? path.resolve(process.env.FACTORY_DATA_ROOT)
  : path.join(process.cwd(), ".data");
export const WORKSPACES_ROOT = path.join(DATA_ROOT, "workspaces");
const DB_PATH = path.join(DATA_ROOT, "factory.json");
const DB_VERSION = 2;

type DbGlobal = typeof globalThis & {
  __factoryDb?: FactoryDb;
  __factoryWriteChain?: Promise<void>;
};
const globalStore = globalThis as DbGlobal;

function freshDb(): FactoryDb {
  const now = Date.now();
  return {
    version: DB_VERSION,
    agents: defaultAgents("ollama/qwen3.8:27b-mlx", "ollama/gpt-oss:20b"),
    projects: [],
    runs: [],
    metrics: [],
    threads: [],
    settings: { ...DEFAULT_SETTINGS, updatedAt: now },
    canvasTopology: null,
    activeTopology: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function ensureDirs() {
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });
}

async function readFromDisk(): Promise<FactoryDb> {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as FactoryDb;
    const fresh = freshDb();
    return {
      ...fresh,
      ...parsed,
      version: DB_VERSION,
      settings: { ...fresh.settings, ...parsed.settings },
      agents: Array.isArray(parsed.agents) && parsed.agents.length ? parsed.agents : fresh.agents,
      canvasTopology: parsed.canvasTopology ?? null,
      activeTopology:
        "activeTopology" in parsed
          ? parsed.activeTopology ?? null
          : parsed.canvasTopology ?? null,
      runs: (parsed.runs ?? []).map((run) =>
        run.status === "running" || run.status === "queued"
          ? {
              ...run,
              status: "recoverable_paused" as const,
              error: "Server restarted while this run was active. Resume from its last saved phase.",
              updatedAt: Date.now(),
            }
          : run,
      ),
    };
  } catch {
    return freshDb();
  }
}

async function persist(db: FactoryDb) {
  await ensureDirs();
  db.updatedAt = Date.now();
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  await fs.rename(tmp, DB_PATH);
}

export async function getDb(): Promise<FactoryDb> {
  if (!globalStore.__factoryDb) {
    await ensureDirs();
    globalStore.__factoryDb = await readFromDisk();
    await persist(globalStore.__factoryDb);
  }
  return globalStore.__factoryDb;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let isPersisting = false;
let hasPendingChanges = false;
let pendingDb: FactoryDb | null = null;
let persistResolvers: Array<() => void> = [];

async function triggerPersist(): Promise<void> {
  if (isPersisting) {
    hasPendingChanges = true;
    return;
  }
  isPersisting = true;
  hasPendingChanges = false;
  const targetDb = pendingDb ?? globalStore.__factoryDb;
  const currentResolvers = persistResolvers;
  persistResolvers = [];
  try {
    if (targetDb) {
      await persist(targetDb);
    }
  } catch (error) {
    console.error("Failed to persist factory DB:", error);
  } finally {
    isPersisting = false;
    currentResolvers.forEach((res) => {
      try {
        res();
      } catch {}
    });
    if (hasPendingChanges) {
      void triggerPersist();
    }
  }
}

function schedulePersist(db: FactoryDb): Promise<void> {
  pendingDb = db;
  return new Promise<void>((resolve) => {
    persistResolvers.push(resolve);
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void triggerPersist();
      }, 50);
    }
  });
}

export async function updateDb<T>(mutator: (db: FactoryDb) => T | Promise<T>): Promise<T> {
  const db = await getDb();
  const result = await mutator(db);
  db.updatedAt = Date.now();
  await schedulePersist(db);
  return result;
}

export async function getSettings(): Promise<FactorySettings> {
  return (await getDb()).settings;
}

export async function updateSettings(
  patch: Partial<FactorySettings>,
): Promise<FactorySettings> {
  return updateDb((db) => {
    db.settings = { ...db.settings, ...patch, updatedAt: Date.now() };
    return db.settings;
  });
}

export interface CanvasDbSnapshot {
  topology: CanvasTopology | null;
  active: CanvasTopology | null;
  updatedAt: number;
}

export async function getCanvasSnapshot(): Promise<CanvasDbSnapshot> {
  const db = await getDb();
  return {
    topology: db.canvasTopology ?? null,
    active: db.activeTopology ?? null,
    updatedAt: db.updatedAt,
  };
}

/** Persist the editor DAG and optionally promote it to the active run blueprint. */
export async function saveCanvasTopology(
  topology: CanvasTopology,
  activate = false,
): Promise<CanvasDbSnapshot> {
  return updateDb((db) => {
    const stamped = { ...topology, updatedAt: Date.now() };
    db.canvasTopology = stamped;
    if (activate) db.activeTopology = stamped;
    return {
      topology: db.canvasTopology ?? null,
      active: db.activeTopology ?? null,
      updatedAt: db.updatedAt,
    };
  });
}

export async function clearActiveTopology(): Promise<CanvasDbSnapshot> {
  return updateDb((db) => {
    db.activeTopology = null;
    return {
      topology: db.canvasTopology ?? null,
      active: db.activeTopology ?? null,
      updatedAt: db.updatedAt,
    };
  });
}

export async function getActiveTopology(): Promise<CanvasTopology | null> {
  return (await getDb()).activeTopology ?? null;
}

export async function listAgents(): Promise<Agent[]> {
  return (await getDb()).agents;
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  return (await getDb()).agents.find((agent) => agent.id === id);
}

export async function saveAgent(agent: Agent): Promise<Agent> {
  return updateDb((db) => {
    const index = db.agents.findIndex((item) => item.id === agent.id);
    if (index >= 0) db.agents[index] = agent;
    else db.agents.push(agent);
    return agent;
  });
}

export async function deleteAgent(id: string): Promise<boolean> {
  return updateDb((db) => {
    const before = db.agents.length;
    db.agents = db.agents.filter((agent) => agent.id !== id);
    return db.agents.length !== before;
  });
}

export async function listProjects(): Promise<Project[]> {
  return (await getDb()).projects;
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await getDb()).projects.find((project) => project.id === id);
}

export async function saveProject(project: Project): Promise<Project> {
  return updateDb((db) => {
    const index = db.projects.findIndex((item) => item.id === project.id);
    if (index >= 0) db.projects[index] = project;
    else db.projects.push(project);
    return project;
  });
}

export async function deleteProject(id: string): Promise<boolean> {
  return updateDb((db) => {
    const before = db.projects.length;
    db.projects = db.projects.filter((project) => project.id !== id);
    db.runs = db.runs.filter((run) => run.projectId !== id);
    return db.projects.length !== before;
  });
}

export async function listRuns(limit = 50): Promise<Run[]> {
  return (await getDb()).runs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function getRun(id: string): Promise<Run | undefined> {
  return (await getDb()).runs.find((run) => run.id === id);
}

export async function saveRun(run: Run): Promise<Run> {
  return updateDb((db) => {
    const index = db.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) db.runs[index] = run;
    else {
      db.runs.unshift(run);
      if (db.runs.length > 40) db.runs = db.runs.slice(0, 40);
    }
    return run;
  });
}

export async function updateRun(
  id: string,
  mutator: (run: Run) => void | Promise<void>,
): Promise<Run | undefined> {
  return updateDb(async (db) => {
    const run = db.runs.find((item) => item.id === id);
    if (!run) return undefined;
    await mutator(run);
    run.updatedAt = Date.now();
    return run;
  });
}

export async function appendMetric(metric: AgentMetric): Promise<AgentMetric> {
  return updateDb((db) => {
    db.metrics.unshift(metric);
    if (db.metrics.length > 600) db.metrics = db.metrics.slice(0, 600);
    return metric;
  });
}

export async function listMetrics(agentId?: string, limit = 100): Promise<AgentMetric[]> {
  const db = await getDb();
  return db.metrics
    .filter((metric) => (agentId ? metric.agentId === agentId : true))
    .slice(0, limit);
}

export async function getThread(id: string): Promise<ChatThread | undefined> {
  return (await getDb()).threads.find((thread) => thread.id === id);
}

export async function listThreads(): Promise<ChatThread[]> {
  return (await getDb()).threads.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function appendThreadMessage(
  threadId: string,
  message: ChatMessage,
): Promise<ChatThread> {
  return updateDb((db) => {
    let thread = db.threads.find((item) => item.id === threadId);
    if (!thread) {
      thread = {
        id: threadId,
        title: "New conversation",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.threads.unshift(thread);
    }
    thread.messages.push(message);
    thread.updatedAt = Date.now();
    if (thread.title === "New conversation" && message.role === "user") {
      thread.title = message.content.slice(0, 64);
    }
    if (thread.messages.length > 400) thread.messages = thread.messages.slice(-400);
    return thread;
  });
}

export async function updateThreadMessage(
  threadId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): Promise<void> {
  await updateDb((db) => {
    const thread = db.threads.find((item) => item.id === threadId);
    const message = thread?.messages.find((item) => item.id === messageId);
    if (message) Object.assign(message, patch);
  });
}

export async function createThread(thread: ChatThread): Promise<ChatThread> {
  return updateDb((db) => {
    if (!db.threads.some((item) => item.id === thread.id)) db.threads.unshift(thread);
    return thread;
  });
}

export async function deleteThread(id: string): Promise<void> {
  await updateDb((db) => {
    db.threads = db.threads.filter((thread) => thread.id !== id);
  });
}

export async function resetDb(): Promise<FactoryDb> {
  const db = freshDb();
  globalStore.__factoryDb = db;
  await persist(db);
  return db;
}

export function projectThreadMessages(messages: ChatMessage[]): {
  direct: ChatMessage[];
  handoffs: ChatMessage[];
  directCount: number;
  handoffCount: number;
  totalCount: number;
} {
  const direct = messages.filter((message) => !message.handoffFrom);
  const handoffs = messages.filter((message) => Boolean(message.handoffFrom));
  return {
    direct,
    handoffs,
    directCount: direct.length,
    handoffCount: handoffs.length,
    totalCount: messages.length,
  };
}
