import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getSettings } from "../db";
import type { ModelInfo } from "../types";

const execFileAsync = promisify(execFile);

type Cache = {
  at: number;
  models: ModelInfo[];
  ollamaOnline: boolean;
  opencodeOnline: boolean;
  opencodeUrl: string;
  error?: string;
};

const globalStore = globalThis as typeof globalThis & {
  __factoryModelCache?: Cache;
  __factoryOpencodeUrl?: string;
};

const CACHE_MS = 12_000;

export const STATIC_CLOUD_MODELS: Array<{
  id: string;
  name: string;
  context: number;
  cost?: number;
}> = [
  { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", context: 1_000_000 },
  { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", context: 1_000_000 },
  { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free", context: 1_000_000 },
  { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", context: 1_000_000 },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", context: 1_000_000 },
  { id: "big-pickle", name: "Big Pickle", context: 200_000 },
  { id: "beam-free", name: "Beam Free", context: 1_048_576 },
  { id: "space-bunny-free", name: "Space Bunny Free", context: 1_000_000 },
];

function estimateVramMB(sizeBytes?: number): number {
  if (!sizeBytes) return 0;
  // Model weights + KV cache / runtime overhead. Tuned for 4-bit/8-bit MLX and GGUF models.
  const weightsMB = sizeBytes / 1024 ** 2;
  return Math.round(weightsMB * 1.12 + 2048);
}

function mapOllamaModel(raw: {
  name: string;
  size?: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
    families?: string[];
  };
  capabilities?: string[];
}): ModelInfo {
  const sizeBytes = raw.size ?? 0;
  const vramEstimateMB = estimateVramMB(sizeBytes);
  return {
    key: `ollama/${raw.name}`,
    provider: "ollama",
    modelId: raw.name,
    name: raw.name,
    kind: "local",
    sizeBytes,
    parameterSize: raw.details?.parameter_size,
    quantization: raw.details?.quantization_level,
    family: raw.details?.family ?? raw.details?.families?.[0],
    capabilities: raw.capabilities ?? ["completion", "tools"],
    heavy: vramEstimateMB >= 14_000,
    vramEstimateMB,
    costInputPerMTok: 0,
    costOutputPerMTok: 0,
    zeroCost: true,
    source: "ollama",
    online: true,
  };
}

function mapCloudModel(raw: {
  id: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: Array<{ input: number; output: number }>;
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
  time?: { released?: number };
}): ModelInfo {
  const cost = raw.cost?.[0];
  const input = cost?.input ?? 0;
  const output = cost?.output ?? 0;
  const capabilities = new Set<string>(["completion"]);
  if (raw.capabilities?.tools) capabilities.add("tools");
  for (const modality of raw.capabilities?.input ?? []) capabilities.add(modality);
  return {
    key: `opencode/${raw.id}`,
    provider: "opencode",
    modelId: raw.id,
    name: raw.name ?? raw.id,
    kind: "cloud",
    contextLength: raw.limit?.context ?? 200_000,
    capabilities: Array.from(capabilities),
    heavy: false,
    vramEstimateMB: 0,
    costInputPerMTok: input,
    costOutputPerMTok: output,
    zeroCost: input === 0 && output === 0,
    releaseDate: raw.time?.released,
    source: "opencode",
    online: true,
  };
}

export async function discoverOpenCodeUrl(): Promise<string> {
  const settings = await getSettings();
  if (process.env.OPENCODE_URL) return process.env.OPENCODE_URL.replace(/\/$/, "");
  if (settings.opencodeUrl) return settings.opencodeUrl.replace(/\/$/, "");
  if (globalStore.__factoryOpencodeUrl) return globalStore.__factoryOpencodeUrl;
  try {
    const { stdout } = await execFileAsync("opencode", ["service", "status"], {
      timeout: 3000,
    });
    const match = stdout.match(/https?:\/\/[^\s]+/);
    if (match) {
      globalStore.__factoryOpencodeUrl = match[0].replace(/\/$/, "");
      return globalStore.__factoryOpencodeUrl;
    }
  } catch {
    // OpenCode CLI is optional; cloud models remain visible but unavailable.
  }
  return "http://127.0.0.1:49374";
}

export async function discoverOpenCodePassword(): Promise<string> {
  const settings = await getSettings();
  if (settings.opencodePassword) return settings.opencodePassword;
  if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD;
  try {
    const raw = await fs.readFile(
      path.join(os.homedir(), ".config", "opencode", "service.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { password?: string };
    return parsed.password ?? "";
  } catch {
    return "";
  }
}

export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export async function opencodeFetch(
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 4000,
): Promise<Response> {
  const [url, password] = await Promise.all([discoverOpenCodeUrl(), discoverOpenCodePassword()]);
  return fetch(`${url}${pathname}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(password ? { authorization: basicAuth(password) } : {}),
      "content-type": "application/json",
    },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
}

async function fetchOllamaModels(): Promise<{ models: ModelInfo[]; online: boolean }> {
  const settings = await getSettings();
  try {
    const res = await fetch(`${settings.ollamaUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const json = (await res.json()) as { models?: Parameters<typeof mapOllamaModel>[0][] };
    const models = (json.models ?? [])
      .map(mapOllamaModel)
      .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    return { models, online: true };
  } catch {
    return { models: [], online: false };
  }
}

async function fetchOpenCodeModels(): Promise<{
  models: ModelInfo[];
  online: boolean;
  url: string;
}> {
  const url = await discoverOpenCodeUrl();
  try {
    const res = await opencodeFetch("/api/model", {}, 3500);
    if (!res.ok) throw new Error(`OpenCode HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: Parameters<typeof mapCloudModel>[0][];
    };
    const cloud = (json.data ?? [])
      .filter((model) => model.capabilities && model.id)
      .map(mapCloudModel)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { models: cloud, online: true, url };
  } catch {
    return {
      models: STATIC_CLOUD_MODELS.map((model) =>
        mapCloudModel({
          id: model.id,
          name: model.name,
          limit: { context: model.context },
        }),
      ),
      online: false,
      url,
    };
  }
}

export async function listModels(force = false): Promise<Cache> {
  const cached = globalStore.__factoryModelCache;
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached;

  const [ollama, opencode] = await Promise.all([fetchOllamaModels(), fetchOpenCodeModels()]);
  const models = [...ollama.models, ...opencode.models];
  const cache: Cache = {
    at: Date.now(),
    models,
    ollamaOnline: ollama.online,
    opencodeOnline: opencode.online,
    opencodeUrl: opencode.url,
  };
  globalStore.__factoryModelCache = cache;
  return cache;
}

export async function getModel(key: string): Promise<ModelInfo | undefined> {
  const { models } = await listModels();
  const found = models.find((model) => model.key === key);
  if (found) return found;
  if (key.startsWith("opencode/")) {
    const id = key.slice("opencode/".length);
    const known = STATIC_CLOUD_MODELS.find((model) => model.id === id);
    return mapCloudModel({
      id,
      name: known?.name ?? id,
      limit: { context: known?.context ?? 200_000 },
    });
  }
  if (key.startsWith("ollama/")) {
    return {
      key,
      provider: "ollama",
      modelId: key.slice("ollama/".length),
      name: key.slice("ollama/".length),
      kind: "local",
      capabilities: ["completion"],
      heavy: true,
      vramEstimateMB: 20_000,
      costInputPerMTok: 0,
      costOutputPerMTok: 0,
      zeroCost: true,
      source: "static",
      online: false,
    };
  }
  return undefined;
}

export async function getModelCatalogue(): Promise<{
  models: ModelInfo[];
  ollamaOnline: boolean;
  opencodeOnline: boolean;
  opencodeUrl: string;
}> {
  const cache = await listModels();
  return {
    models: cache.models,
    ollamaOnline: cache.ollamaOnline,
    opencodeOnline: cache.opencodeOnline,
    opencodeUrl: cache.opencodeUrl,
  };
}

export function invalidateModelCache() {
  globalStore.__factoryModelCache = undefined;
  globalStore.__factoryOpencodeUrl = undefined;
}
