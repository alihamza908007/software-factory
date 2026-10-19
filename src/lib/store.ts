"use client";

import { create } from "zustand";
import type {
  Agent,
  AgentMetric,
  FactorySettings,
  ModelInfo,
  Project,
  ResourceSnapshot,
  Run,
} from "./types";

interface HealthPayload {
  ok: boolean;
  ollama: { online: boolean; version?: string; url: string };
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

interface ProjectWithRuns extends Project {
  runCount?: number;
  lastRun?: Run | null;
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
  }) | null;
  resolvedOpencodeUrl: string;
  resources: ResourceSnapshot | null;
  health: HealthPayload | null;
  loading: boolean;
  error: string | null;
  fetchModels: (refresh?: boolean) => Promise<void>;
  fetchAgents: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  fetchRuns: () => Promise<void>;
  fetchSettings: () => Promise<void>;
  fetchResources: () => Promise<void>;
  fetchHealth: () => Promise<void>;
  refreshAll: () => Promise<void>;
  updateAgentLocal: (agent: Agent) => void;
  patchModel: (agentId: string, modelKey: string) => Promise<Agent | undefined>;
  setError: (error: string | null) => void;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export const useFactory = create<FactoryStore>((set, get) => ({
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
  loading: false,
  error: null,

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

  refreshAll: async () => {
    set({ loading: true });
    await Promise.all([
      get().fetchModels(),
      get().fetchAgents(),
      get().fetchProjects(),
      get().fetchRuns(),
      get().fetchSettings(),
      get().fetchHealth(),
    ]);
    set({ loading: false });
  },

  updateAgentLocal: (agent) =>
    set((state) => ({
      agents: state.agents.map((item) => (item.id === agent.id ? agent : item)),
    })),

  patchModel: async (agentId, modelKey) => {
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelKey }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not switch model.");
      const data = (await res.json()) as { agent: Agent };
      set((state) => ({
        agents: state.agents.map((agent) => (agent.id === data.agent.id ? data.agent : agent)),
      }));
      return data.agent;
    } catch (error) {
      set({ error: String(error) });
      return undefined;
    }
  },

  setError: (error) => set({ error }),
}));
