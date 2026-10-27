import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getSettings } from "../db";
import type { FactorySettings, ModelInfo, ModelProvider } from "../types";

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

export const STATIC_UNIVERSAL_MODELS: Array<{
  provider: Exclude<ModelProvider, "ollama" | "opencode" | "lmstudio">;
  id: string;
  name: string;
  context: number;
  input: number;
  output: number;
}> = [
  { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4 (OpenRouter)", context: 200_000, input: 3, output: 15 },
  { provider: "openrouter", id: "openai/gpt-4.1-mini", name: "GPT-4.1 mini (OpenRouter)", context: 1_000_000, input: 0.4, output: 1.6 },
  { provider: "openrouter", id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (OpenRouter)", context: 1_000_000, input: 0.3, output: 2.5 },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: 200_000, input: 3, output: 15 },
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000, input: 1, output: 5 },
  { provider: "openai", id: "gpt-4.1", name: "GPT-4.1", context: 1_000_000, input: 2, output: 8 },
  { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini", context: 1_000_000, input: 0.4, output: 1.6 },
  { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1_000_000, input: 0.3, output: 2.5 },
  { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", context: 1_000_000, input: 1.25, output: 10 },
];

function providerKey(settings: FactorySettings, provider: ModelProvider): string {
  if (provider === "openrouter") return settings.openrouterApiKey;
  if (provider === "anthropic") return settings.anthropicApiKey;
  if (provider === "openai") return settings.openaiApiKey;
  if (provider === "google") return settings.geminiApiKey;
  return "";
}

function mapUniversalModel(
  raw: (typeof STATIC_UNIVERSAL_MODELS)[number],
  settings: FactorySettings,
): ModelInfo {
  const configured = Boolean(providerKey(settings, raw.provider));
  return {
    key: `${raw.provider}/${raw.id}`,
    provider: raw.provider,
    modelId: raw.id,
    name: raw.name,
    kind: "cloud",
    contextLength: raw.context,
    capabilities: ["completion", "tools"],
    heavy: false,
    vramEstimateMB: 0,
    costInputPerMTok: raw.input,
    costOutputPerMTok: raw.output,
    zeroCost: raw.input === 0 && raw.output === 0,
    source: raw.provider,
    online: configured,
  };
}

function mapLmStudioModel(raw: { id: string }, online: boolean): ModelInfo {
  return {
    key: `lmstudio/${raw.id}`,
    provider: "lmstudio",
    modelId: raw.id,
    name: raw.id,
    kind: "local",
    capabilities: ["completion"],
    heavy: isHeavyLocalModel(raw.id),
    vramEstimateMB: 12_000,
    costInputPerMTok: 0,
    costOutputPerMTok: 0,
    zeroCost: true,
    source: "lmstudio",
    online,
  };
}

async function fetchLmStudio(settings: FactorySettings): Promise<ModelInfo[]> {
  try {
    const res = await fetch(`${settings.lmstudioUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id?: string }> };
    return (payload.data ?? [])
      .filter((model): model is { id: string } => Boolean(model.id))
      .map((model) => mapLmStudioModel(model, true));
  } catch {
    return [];
  }
}

function estimateVramMB(sizeBytes?: number): number {
  if (!sizeBytes) return 0;
  // Model weights + KV cache / runtime overhead. Tuned for 4-bit/8-bit MLX and GGUF models.
  const weightsMB = sizeBytes / 1024 ** 2;
  return Math.round(weightsMB * 1.12 + 2048);
}

function isHeavyLocalModel(name: string, parameterSize?: string, vramEstimateMB = 0): boolean {
  const size = `${parameterSize ?? ""} ${name}`.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*b(?:\b|$)/i);
  if (size) return Number(size[1]) > 13;
  return vramEstimateMB >= 14_000;
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
    heavy: isHeavyLocalModel(raw.name, raw.details?.parameter_size, vramEstimateMB),
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

  const settings = await getSettings();
  const [ollama, opencode, lmstudio] = await Promise.all([
    fetchOllamaModels(),
    fetchOpenCodeModels(),
    fetchLmStudio(settings),
  ]);
  const universal = STATIC_UNIVERSAL_MODELS.map((model) => mapUniversalModel(model, settings));
  const models = [...ollama.models, ...lmstudio, ...opencode.models, ...universal];
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
  if (key.startsWith("lmstudio/")) {
    return {
      key,
      provider: "lmstudio",
      modelId: key.slice("lmstudio/".length),
      name: key.slice("lmstudio/".length),
      kind: "local",
      capabilities: ["completion"],
      heavy: false,
      vramEstimateMB: 8_000,
      costInputPerMTok: 0,
      costOutputPerMTok: 0,
      zeroCost: true,
      source: "static",
      online: false,
    };
  }
  const slash = key.indexOf("/");
  if (slash > 0) {
    const provider = key.slice(0, slash) as ModelProvider;
    const modelId = key.slice(slash + 1);
    const known = STATIC_UNIVERSAL_MODELS.find(
      (model) => model.provider === provider && model.id === modelId,
    );
    if (known) return mapUniversalModel(known, await getSettings());
    if (["openrouter", "anthropic", "openai", "google"].includes(provider)) {
      return {
        key,
        provider,
        modelId,
        name: modelId,
        kind: "cloud",
        contextLength: 200_000,
        capabilities: ["completion"],
        heavy: false,
        vramEstimateMB: 0,
        costInputPerMTok: 0,
        costOutputPerMTok: 0,
        zeroCost: false,
        source: "static",
        online: false,
      };
    }
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
