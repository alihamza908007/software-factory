import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../db";
import type { MeshControlSnapshot } from "../types";
import { meshBus } from "./event-bus";

const CONTROL_PATH = path.join(DATA_ROOT, "mesh-controls.json");

interface ControlState extends MeshControlSnapshot {
  overrides: Record<string, { reason: string; at: number }>;
}

interface ControlGlobal {
  __factoryMeshControls?: ControlState;
  __factoryMeshControlsWrite?: Promise<void>;
}

const globalStore = globalThis as typeof globalThis & ControlGlobal;
let loadPromise: Promise<ControlState> | undefined;

function fresh(): ControlState {
  return {
    pausedAgentIds: [],
    overriddenEventIds: [],
    overrides: {},
    updatedAt: Date.now(),
  };
}

async function load(): Promise<ControlState> {
  if (globalStore.__factoryMeshControls) return globalStore.__factoryMeshControls;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(CONTROL_PATH, "utf8");
        const parsed = JSON.parse(raw) as Partial<ControlState>;
        const state: ControlState = {
          pausedAgentIds: parsed.pausedAgentIds ?? [],
          overriddenEventIds: parsed.overriddenEventIds ?? [],
          overrides: parsed.overrides ?? {},
          updatedAt: parsed.updatedAt ?? Date.now(),
        };
        globalStore.__factoryMeshControls = state;
        return state;
      } catch {
        const state = fresh();
        globalStore.__factoryMeshControls = state;
        return state;
      }
    })();
  }
  return loadPromise;
}

async function persist(state: ControlState): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  state.updatedAt = Date.now();
  const tmp = `${CONTROL_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, CONTROL_PATH);
}

async function mutate<T>(fn: (state: ControlState) => T): Promise<T> {
  const state = await load();
  const result = fn(state);
  globalStore.__factoryMeshControlsWrite = (
    globalStore.__factoryMeshControlsWrite ?? Promise.resolve()
  )
    .catch(() => undefined)
    .then(() => persist(state));
  await globalStore.__factoryMeshControlsWrite;
  return result;
}

export async function getControlSnapshot(): Promise<MeshControlSnapshot> {
  const state = await load();
  return {
    pausedAgentIds: [...state.pausedAgentIds],
    overriddenEventIds: [...state.overriddenEventIds],
    updatedAt: state.updatedAt,
  };
}

export async function isAgentPaused(agentId: string): Promise<boolean> {
  return (await load()).pausedAgentIds.includes(agentId);
}

export async function setAgentPaused(
  agentId: string,
  paused: boolean,
  detail?: string,
): Promise<MeshControlSnapshot> {
  const snapshot = await mutate((state) => {
    const ids = new Set(state.pausedAgentIds);
    if (paused) ids.add(agentId);
    else ids.delete(agentId);
    state.pausedAgentIds = Array.from(ids);
    return {
      pausedAgentIds: [...state.pausedAgentIds],
      overriddenEventIds: [...state.overriddenEventIds],
      updatedAt: state.updatedAt,
    };
  });
  meshBus.publish({
    type: "AGENT_STATUS",
    source: "Mesh Control",
    agentId,
    severity: paused ? "warning" : "info",
    title: paused ? "Agent thread paused" : "Agent thread resumed",
    message:
      detail ??
      (paused
        ? "New handoffs to this agent are held until the thread is resumed."
        : "The agent is accepting handoffs again."),
    payload: { status: paused ? "paused" : "idle", detail },
  });
  return snapshot;
}

export async function isValidationOverridden(eventId: string): Promise<boolean> {
  return Boolean((await load()).overriddenEventIds.includes(eventId));
}

export async function overrideValidation(
  eventId: string,
  reason: string,
  agentId?: string,
): Promise<MeshControlSnapshot> {
  const cleanReason = reason.trim().slice(0, 400) || "Operator override.";
  const snapshot = await mutate((state) => {
    if (!state.overriddenEventIds.includes(eventId)) state.overriddenEventIds.push(eventId);
    state.overrides[eventId] = { reason: cleanReason, at: Date.now() };
    if (state.overriddenEventIds.length > 200) {
      const active = state.overriddenEventIds.slice(-200);
      state.overriddenEventIds = active;
      state.overrides = Object.fromEntries(
        Object.entries(state.overrides).filter(([id]) => active.includes(id)),
      );
    }
    return {
      pausedAgentIds: [...state.pausedAgentIds],
      overriddenEventIds: [...state.overriddenEventIds],
      updatedAt: state.updatedAt,
    };
  });
  meshBus.publish({
    type: "VALIDATION_OVERRIDDEN",
    source: "Operator",
    agentId,
    severity: "warning",
    title: "Validator block overridden",
    message: cleanReason,
    payload: { eventId, reason: cleanReason },
  });
  return snapshot;
}

export async function clearMeshControls(): Promise<MeshControlSnapshot> {
  const state = await load();
  const resumed = [...state.pausedAgentIds];
  const snapshot = await mutate((state) => {
    state.pausedAgentIds = [];
    state.overriddenEventIds = [];
    state.overrides = {};
    return {
      pausedAgentIds: [],
      overriddenEventIds: [],
      updatedAt: state.updatedAt,
    };
  });
  for (const agentId of resumed) {
    meshBus.publish({
      type: "AGENT_STATUS",
      source: "Mesh Control",
      agentId,
      severity: "info",
      title: "Agent thread resumed",
      message: "Mesh controls were reset; this agent is accepting handoffs again.",
      payload: { status: "idle", detail: "Controls reset" },
    });
  }
  return snapshot;
}
