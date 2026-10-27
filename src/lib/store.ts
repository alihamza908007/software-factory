"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  Agent,
  AgentMemory,
  AgentMetric,
  CanvasTopology,
  FactorySettings,
  MeshAgentState,
  MeshEvent,
  ModelInfo,
  Project,
  ResourceSnapshot,
  Run,
} from "./types";
import type { HardwareOptimizationProfile } from "./system/hardware-profiler";

interface HealthPayload {
  ok: boolean;
  ollama: { online: boolean; version?: string; url: string };
  lmstudio?: { online: boolean; models: number; url: string };
  opencode: { online: boolean; version?: string; url: string };
  models: { total: number; local: number; cloud: number; cloudOnline: boolean };
  hardware: {
    platform: string;
    arch: string;
    cpu: string;
    cores: number;
    totalMemoryMB: number;
    freeMemoryMB: number;
    unifiedMemory: boolean;
  };
  process: { uptimeSec: number; rssMB: number };
  resources: ResourceSnapshot;
}

interface SystemProfilePayload {
  profile: HardwareOptimizationProfile;
  resources: ResourceSnapshot;
}

interface ProjectWithRuns extends Project {
  runCount?: number;
  lastRun?: Run | null;
}

interface MeshSnapshot {
  events: MeshEvent[];
  statuses: MeshAgentState[];
  controls: {
    pausedAgentIds: string[];
    overriddenEventIds: string[];
    updatedAt: number;
  };
  sequence?: number;
  at: number;
}

interface CanvasValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeCount: number;
  edgeCount: number;
}

interface FactoryStore {
  models: ModelInfo[];
  modelsLoaded: boolean;
  modelsLoading: boolean;
  ollamaOnline: boolean;
  opencodeOnline: boolean;
  opencodeUrl: string;
  agents: Agent[];
  metrics: AgentMetric[];
  projects: ProjectWithRuns[];
  runs: Run[];
  settings: (FactorySettings & {
    hasOpencodePassword?: boolean;
    hasGithubToken?: boolean;
    hasOpenrouterApiKey?: boolean;
    hasAnthropicApiKey?: boolean;
    hasOpenaiApiKey?: boolean;
    hasGeminiApiKey?: boolean;
  }) | null;
  canvasTopology: CanvasTopology | null;
  activePipelineTopology: CanvasTopology | null;
  canvasValidation: CanvasValidation | null;
  canvasLoading: boolean;
  canvasLogs: string[];
  setCanvasTopology: (topology: CanvasTopology | null) => void;
  setActivePipelineTopology: (topology: CanvasTopology | null) => void;
  fetchCanvas: () => Promise<void>;
  saveCanvasTopology: (topology: CanvasTopology, activate?: boolean) => Promise<boolean>;
  deactivateCanvasTopology: () => Promise<boolean>;
  setCanvasLogs: (logs: string[]) => void;
  appendCanvasLog: (line: string) => void;
  resolvedOpencodeUrl: string;
  resources: ResourceSnapshot | null;
  health: HealthPayload | null;
  systemProfile: HardwareOptimizationProfile | null;
  loading: boolean;
  error: string | null;
  meshEvents: MeshEvent[];
  meshStatuses: Record<string, MeshAgentState>;
  meshMemory: AgentMemory[];
  meshConnected: boolean;
  meshSequence: number;
  lastMeshEventAt: number;
  pausedAgentIds: string[];
  overriddenEventIds: string[];
  fetchModels: (refresh?: boolean) => Promise<void>;
  fetchAgents: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  fetchRuns: () => Promise<void>;
  fetchSettings: () => Promise<void>;
  fetchResources: () => Promise<void>;
  fetchHealth: () => Promise<void>;
  fetchSystemProfile: () => Promise<void>;
  fetchMeshMemory: () => Promise<void>;
  refreshAll: () => Promise<void>;
  updateAgentLocal: (agent: Agent) => void;
  patchAgent: (
    agentId: string,
    patch: Partial<Pick<Agent, "modelKey" | "systemPrompt" | "temperature" | "maxTokens" | "enabled" | "fallbackModelKey">>,
  ) => Promise<Agent | undefined>;
  patchModel: (agentId: string, modelKey: string) => Promise<Agent | undefined>;
  toggleAgentPause: (agentId: string) => Promise<void>;
  resetMeshControls: () => Promise<void>;
  overrideValidator: (eventId: string, agentId?: string, reason?: string) => Promise<void>;
  ingestMeshEvent: (event: MeshEvent) => void;
  connectMesh: () => void;
  disconnectMesh: () => void;
  setError: (error: string | null) => void;
}

let meshSource: EventSource | null = null;
let meshReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function mergeMeshEvents(current: MeshEvent[], incoming: MeshEvent[]): MeshEvent[] {
  const byId = new Map<string, MeshEvent>();
  for (const event of [...current, ...incoming]) {
    if (!event?.id) continue;
    const previous = byId.get(event.id);
    if (!previous || event.at >= previous.at) byId.set(event.id, event);
  }
  return Array.from(byId.values())
    .sort(
      (left, right) =>
        left.at - right.at || (left.sequence ?? 0) - (right.sequence ?? 0),
    )
    .slice(-180);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function statusRecord(statuses: MeshAgentState[]): Record<string, MeshAgentState> {
  return Object.fromEntries(statuses.map((status) => [status.agentId, status]));
}

export const useFactory = create<FactoryStore>()(
  persist(
    (set, get) => ({
      models: [],
      modelsLoaded: false,
      modelsLoading: false,
      ollamaOnline: false,
      opencodeOnline: false,
      opencodeUrl: "",
      agents: [],
      metrics: [],
      projects: [],
      runs: [],
      settings: null,
      resolvedOpencodeUrl: "",
      resources: null,
      health: null,
      systemProfile: null,
      loading: false,
      error: null,
      canvasTopology: null,
      activePipelineTopology: null,
      canvasValidation: null,
      canvasLoading: true,
      canvasLogs: [],
      meshEvents: [],
      meshStatuses: {},
      meshMemory: [],
      meshConnected: false,
      meshSequence: 0,
      lastMeshEventAt: 0,
      pausedAgentIds: [],
      overriddenEventIds: [],

      setCanvasTopology: (topology) => set({ canvasTopology: topology }),
      setActivePipelineTopology: (topology) => set({ activePipelineTopology: topology }),

      fetchCanvas: async () => {
        set({ canvasLoading: true });
        try {
          const data = await getJson<{
            topology: CanvasTopology | null;
            active: CanvasTopology | null;
            validation: CanvasValidation | null;
          }>("/api/canvas");
          set((state) => ({
            canvasTopology: data.topology ?? state.canvasTopology,
            activePipelineTopology: data.active,
            canvasValidation: data.validation,
            canvasLoading: false,
          }));
        } catch (error) {
          set({ canvasLoading: false, error: String(error) });
        }
      },

      saveCanvasTopology: async (topology, activate = false) => {
        try {
          const res = await fetch("/api/canvas", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: activate ? "activate" : "save", topology }),
          });
          const data = (await res.json()) as {
            topology?: CanvasTopology | null;
            active?: CanvasTopology | null;
            validation?: CanvasValidation;
            error?: string;
          };
          if (!res.ok) throw new Error(data.error ?? "Could not save the canvas topology.");
          set((state) => ({
            canvasTopology: data.topology ?? topology,
            activePipelineTopology: activate ? data.active ?? topology : state.activePipelineTopology,
            canvasValidation: data.validation ?? state.canvasValidation,
            error: null,
          }));
          return true;
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },

      deactivateCanvasTopology: async () => {
        try {
          const res = await fetch("/api/canvas", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "deactivate" }),
          });
          if (!res.ok) throw new Error((await res.json()).error ?? "Could not deactivate the canvas.");
          set({ activePipelineTopology: null });
          return true;
        } catch (error) {
          set({ error: String(error) });
          return false;
        }
      },
      setCanvasLogs: (logs) => set({ canvasLogs: logs.slice(-250) }),
      appendCanvasLog: (line) =>
        set((state) => ({ canvasLogs: [...state.canvasLogs, line].slice(-250) })),

      fetchModels: async (refresh = false) => {
        if (get().modelsLoading) return;
        set({ modelsLoading: true });
        try {
          const data = await getJson<{
            models: ModelInfo[];
            ollamaOnline: boolean;
            opencodeOnline: boolean;
            opencodeUrl: string;
            resources: ResourceSnapshot;
          }>(`/api/models${refresh ? "?refresh=1" : ""}`);
          set({
            models: data.models,
            ollamaOnline: data.ollamaOnline,
            opencodeOnline: data.opencodeOnline,
            opencodeUrl: data.opencodeUrl,
            resources: data.resources,
            modelsLoaded: true,
            modelsLoading: false,
            error: null,
          });
        } catch (error) {
          set({ modelsLoading: false, error: String(error) });
        }
      },

      fetchAgents: async () => {
        try {
          const data = await getJson<{ agents: Agent[]; metrics: AgentMetric[] }>("/api/agents");
          set({ agents: data.agents, metrics: data.metrics });
        } catch (error) {
          set({ error: String(error) });
        }
      },

      fetchProjects: async () => {
        try {
          const data = await getJson<{ projects: ProjectWithRuns[] }>("/api/projects");
          set({ projects: data.projects });
        } catch (error) {
          set({ error: String(error) });
        }
      },

      fetchRuns: async () => {
        try {
          const data = await getJson<{ runs: Run[] }>("/api/runs?limit=60");
          set({ runs: data.runs });
        } catch (error) {
          set({ error: String(error) });
        }
      },

      fetchSettings: async () => {
        try {
          const data = await getJson<{
            settings: FactorySettings & {
              hasOpencodePassword?: boolean;
              hasGithubToken?: boolean;
              hasOpenrouterApiKey?: boolean;
              hasAnthropicApiKey?: boolean;
              hasOpenaiApiKey?: boolean;
              hasGeminiApiKey?: boolean;
            };
            resolvedOpencodeUrl: string;
          }>("/api/settings");
          set({ settings: data.settings, resolvedOpencodeUrl: data.resolvedOpencodeUrl });
        } catch (error) {
          set({ error: String(error) });
        }
      },

      fetchResources: async () => {
        try {
          const data = await getJson<{ snapshot: ResourceSnapshot }>("/api/resources");
          set({ resources: data.snapshot });
        } catch {
          // non-critical poll
        }
      },

      fetchHealth: async () => {
        try {
          const data = await getJson<HealthPayload>("/api/health");
          set({ health: data, resources: data.resources });
        } catch {
          // non-critical poll
        }
      },

      fetchSystemProfile: async () => {
        try {
          const data = await getJson<SystemProfilePayload>("/api/system/profile");
          set({ systemProfile: data.profile });
        } catch {
          // Hardware profile is informational; the server still applies its local policy.
        }
      },

      fetchMeshMemory: async () => {
        try {
          const data = await getJson<{ memory: AgentMemory[] }>("/api/mesh/memory");
          set({ meshMemory: data.memory });
        } catch {
          // memory is optional until the first failure is learned
        }
      },

      refreshAll: async () => {
        set({ loading: true });
        await Promise.all([
          get().fetchModels(),
          get().fetchAgents(),
          get().fetchProjects(),
          get().fetchRuns(),
          get().fetchSettings(),
          get().fetchHealth(),
          get().fetchSystemProfile(),
          get().fetchMeshMemory(),
          get().fetchCanvas(),
        ]);
        set({ loading: false });
      },

      updateAgentLocal: (agent) =>
        set((state) => ({
          agents: state.agents.map((item) => (item.id === agent.id ? agent : item)),
        })),

      patchAgent: async (agentId, patch) => {
        const previous = get().agents.find((agent) => agent.id === agentId);
        if (!previous) return undefined;
        // Optimistic write: the UI and any dependent selector update in <1ms,
        // before the network round-trip completes.
        set((state) => ({
          agents: state.agents.map((agent) =>
            agent.id === agentId ? { ...agent, ...patch, updatedAt: Date.now() } : agent,
          ),
        }));
        try {
          const res = await fetch(`/api/agents/${agentId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          if (!res.ok) throw new Error((await res.json()).error ?? "Could not update agent.");
          const data = (await res.json()) as { agent: Agent };
          set((state) => ({
            agents: state.agents.map((agent) => (agent.id === data.agent.id ? data.agent : agent)),
            error: null,
          }));
          return data.agent;
        } catch (error) {
          set((state) => ({
            agents: state.agents.map((agent) => (agent.id === agentId ? previous : agent)),
            error: String(error),
          }));
          return undefined;
        }
      },

      patchModel: async (agentId, modelKey) => get().patchAgent(agentId, { modelKey }),

      toggleAgentPause: async (agentId) => {
        const paused = !get().pausedAgentIds.includes(agentId);
        const previous = get().pausedAgentIds;
        set((state) => ({
          pausedAgentIds: paused
            ? [...state.pausedAgentIds, agentId]
            : state.pausedAgentIds.filter((id) => id !== agentId),
          meshStatuses: {
            ...state.meshStatuses,
            [agentId]: {
              agentId,
              status: paused ? "paused" : "idle",
              detail: paused ? "Operator paused this thread" : "Thread resumed",
              updatedAt: Date.now(),
            },
          },
        }));
        try {
          const res = await fetch("/api/mesh/control", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: paused ? "pause" : "resume",
              agentId,
              reason: paused ? "Paused from the Agent Mesh HUD." : undefined,
            }),
          });
          if (!res.ok) throw new Error((await res.json()).error ?? "Control update failed.");
        } catch (error) {
          set({ pausedAgentIds: previous, error: String(error) });
        }
      },

      resetMeshControls: async () => {
        const previous = {
          pausedAgentIds: get().pausedAgentIds,
          overriddenEventIds: get().overriddenEventIds,
        };
        set({ pausedAgentIds: [], overriddenEventIds: [] });
        try {
          const res = await fetch("/api/mesh/control", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "reset" }),
          });
          if (!res.ok) throw new Error((await res.json()).error ?? "Reset failed.");
        } catch (error) {
          set({ ...previous, error: String(error) });
        }
      },

      overrideValidator: async (eventId, agentId, reason) => {
        set((state) => ({
          overriddenEventIds: state.overriddenEventIds.includes(eventId)
            ? state.overriddenEventIds
            : [...state.overriddenEventIds, eventId].slice(-200),
        }));
        try {
          const res = await fetch("/api/mesh/control", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "override",
              eventId,
              agentId,
              reason: reason ?? "Operator approved this validation warning.",
            }),
          });
          if (!res.ok) throw new Error((await res.json()).error ?? "Override failed.");
        } catch (error) {
          set((state) => ({
            overriddenEventIds: state.overriddenEventIds.filter((id) => id !== eventId),
            error: String(error),
          }));
        }
      },

      ingestMeshEvent: (event) =>
        set((state) => {
          if (!event?.id || state.meshEvents.some((item) => item.id === event.id)) {
            return {};
          }
          const next: Partial<FactoryStore> = {
            meshEvents: [...state.meshEvents, event].slice(-180),
            lastMeshEventAt: event.at,
            meshSequence: Math.max(state.meshSequence, event.sequence ?? 0),
          };
          if (event.type === "AGENT_STATUS" && event.agentId) {
            const raw = event.payload?.status;
            const status =
              raw === "thinking" ||
              raw === "communicating" ||
              raw === "validating" ||
              raw === "executing" ||
              raw === "paused" ||
              raw === "error" ||
              raw === "idle"
                ? raw
                : "idle";
            next.meshStatuses = {
              ...state.meshStatuses,
              [event.agentId]: {
                agentId: event.agentId,
                status,
                detail:
                  typeof event.payload?.detail === "string"
                    ? event.payload.detail
                    : event.message,
                updatedAt: event.at,
              },
            };
          }
          if (event.type === "VALIDATION_OVERRIDDEN") {
            const id =
              typeof event.payload?.eventId === "string" ? event.payload.eventId : undefined;
            if (id && !state.overriddenEventIds.includes(id)) {
              next.overriddenEventIds = [...state.overriddenEventIds, id].slice(-200);
            }
          }
          return next;
        }),

      connectMesh: () => {
        if (typeof window === "undefined" || meshSource) return;
        const since = get().meshSequence;
        const source = new EventSource(
          `/api/mesh/stream${since > 0 ? `?since=${since}` : ""}`,
        );
        meshSource = source;
        source.onopen = () => set({ meshConnected: true });
        source.onerror = () => {
          set({ meshConnected: false });
          source.close();
          if (meshSource === source) meshSource = null;
          if (!meshReconnectTimer) {
            meshReconnectTimer = setTimeout(() => {
              meshReconnectTimer = null;
              get().connectMesh();
            }, 2_500);
          }
        };
        source.addEventListener("snapshot", (raw) => {
          try {
            const data = JSON.parse((raw as MessageEvent<string>).data) as MeshSnapshot;
            set((state) => ({
              meshEvents: mergeMeshEvents(state.meshEvents, data.events ?? []),
              meshStatuses: statusRecord(data.statuses),
              pausedAgentIds: data.controls.pausedAgentIds,
              overriddenEventIds: data.controls.overriddenEventIds,
              meshSequence: Math.max(state.meshSequence, data.sequence ?? 0),
              meshConnected: true,
            }));
          } catch {
            set({ meshConnected: false });
          }
        });
        source.addEventListener("mesh", (raw) => {
          try {
            const event = JSON.parse((raw as MessageEvent<string>).data) as MeshEvent;
            get().ingestMeshEvent(event);
            if (event.type === "MEMORY_CONSTRAINT" || event.type === "AGENT_ENVELOPE") {
              void get().fetchMeshMemory();
            }
          } catch {
            // Ignore malformed frames; EventSource will continue.
          }
        });
      },

      disconnectMesh: () => {
        if (meshReconnectTimer) {
          clearTimeout(meshReconnectTimer);
          meshReconnectTimer = null;
        }
        meshSource?.close();
        meshSource = null;
        set({ meshConnected: false });
      },

      setError: (error) => set({ error }),
    }),
    {
      name: "software-factory-mesh-v1",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Cache agent configuration locally for immediate hydration; server
        // persistence remains authoritative and refreshes this snapshot.
        agents: state.agents,
        canvasTopology: state.canvasTopology,
        activePipelineTopology: state.activePipelineTopology,
        pausedAgentIds: state.pausedAgentIds,
        overriddenEventIds: state.overriddenEventIds,
        meshSequence: state.meshSequence,
      }),
    },
  ),
);
