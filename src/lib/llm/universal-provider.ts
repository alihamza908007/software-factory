import { getSettings } from "../db";
import { generateOllama, type ProviderMessage } from "../providers/ollama";
import { generateOpenCode } from "../providers/opencode";
import type { ModelInfo, ModelProvider } from "../types";

export type { ProviderMessage };

/**
 * One request shape for every model backend. The factory never talks to a
 * vendor SDK directly: it builds a ModelRequest and lets executeLLMCall
 * normalise streaming, usage, errors and token accounting.
 */
export interface ModelRequest {
  provider: ModelProvider;
  modelId: string;
  messages: ProviderMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  jsonMode?: boolean;
  responseSchema?: Record<string, unknown>;
  responseSchemaName?: string;
  signal?: AbortSignal;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  title?: string;
  onToken?: (delta: string, fullText: string) => void;
  onThinking?: (delta: string) => void;
}

export interface LLMCallResult {
  text: string;
  provider: ModelProvider;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  totalMs: number;
  tokensPerSec: number;
  costUsd: number;
  finishReason?: string;
  raw?: unknown;
}

type StreamUsage = { input?: number; output?: number; cost?: number };

const OPENAI_COMPATIBLE: ModelProvider[] = ["openai", "openrouter", "lmstudio"];

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function promptText(messages: ProviderMessage[], system?: string): string {
  return [system ?? "", ...messages.map((message) => `${message.role}: ${message.content}`)]
    .filter(Boolean)
    .join("\n");
}

function withSystem(messages: ProviderMessage[], system?: string): ProviderMessage[] {
  if (!system?.trim()) return messages;
  if (messages.some((message) => message.role === "system")) {
    return messages.map((message) =>
      message.role === "system"
        ? { ...message, content: `${system}\n\n${message.content}` }
        : message,
    );
  }
  return [{ role: "system", content: system }, ...messages];
}

function normaliseBase(url: string): string {
  return url.replace(/\/+$/, "");
}

async function throwProviderError(provider: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  let detail = body.slice(0, 900);
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    detail =
      (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ??
      parsed.message ??
      detail;
  } catch {
    // keep raw text
  }
  throw new Error(`${provider} HTTP ${res.status}: ${detail || res.statusText}`);
}

async function consumeSse(
  res: Response,
  onData: (payload: string) => void,
): Promise<void> {
  if (!res.body) throw new Error("Provider returned an empty streaming body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) onData(line.slice(5).trim());
        newline = buffer.indexOf("\n");
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith("data:")) onData(rest.slice(5).trim());
  } finally {
    reader.releaseLock();
  }
}

function settingsKey(
  settings: Awaited<ReturnType<typeof getSettings>>,
  provider: ModelProvider,
): string {
  switch (provider) {
    case "openrouter":
      return settings.openrouterApiKey;
    case "anthropic":
      return settings.anthropicApiKey;
    case "openai":
      return settings.openaiApiKey;
    case "google":
      return settings.geminiApiKey;
    default:
      return "";
  }
}

async function callOpenAiCompatible(
  request: ModelRequest,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<LLMCallResult> {
  const started = performance.now();
  let firstTokenAt: number | undefined;
  let text = "";
  let finishReason = "stop";
  const usage: StreamUsage = {};

  const apiKey = request.apiKey ?? settingsKey(settings, request.provider);
  if (request.provider !== "lmstudio" && !apiKey) {
    throw new Error(
      `${request.provider} API key is not configured. Add it in Settings → Providers.`,
    );
  }

  const base =
    request.baseUrl ??
    (request.provider === "lmstudio"
      ? settings.lmstudioUrl
      : request.provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : "https://api.openai.com/v1");
  const endpoint = `${normaliseBase(base)}/chat/completions`;
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: withSystem(request.messages, request.system),
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens ?? 4096,
    stream: request.stream !== false,
  };
  if (request.jsonMode && request.provider !== "lmstudio") {
    body.response_format = request.responseSchema
      ? {
          type: "json_schema",
          json_schema: {
            name: request.responseSchemaName ?? "factory_result",
            strict: true,
            schema: request.responseSchema,
          },
        }
      : { type: "json_object" };
  } else if (request.jsonMode && request.provider === "lmstudio") {
    // LM Studio varies by runner; json_object is the broadest compatible mode.
    body.response_format = { type: "json_object" };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (request.provider === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost:3010";
    headers["X-Title"] = "Software Factory";
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal ?? AbortSignal.timeout(request.timeoutMs ?? 8 * 60_000),
    cache: "no-store",
  });
  if (!res.ok) await throwProviderError(request.provider, res);

  if (request.stream !== false && res.body) {
    await consumeSse(res, (payload) => {
      if (payload === "[DONE]") return;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string; reasoning?: string; reasoning_content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };
        const choice = chunk.choices?.[0];
        const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
        if (reasoning) request.onThinking?.(reasoning);
        const delta = choice?.delta?.content;
        if (delta) {
          if (firstTokenAt === undefined) firstTokenAt = performance.now();
          text += delta;
          request.onToken?.(delta, text);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage.input = chunk.usage.prompt_tokens;
          usage.output = chunk.usage.completion_tokens;
          usage.cost = chunk.usage.cost;
        }
      } catch {
        // Ignore keep-alive or vendor-specific frames.
      }
    });
  } else {
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    text = payload.choices?.[0]?.message?.content ?? "";
    finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
    usage.input = payload.usage?.prompt_tokens;
    usage.output = payload.usage?.completion_tokens;
    usage.cost = payload.usage?.cost;
    if (text) request.onToken?.(text, text);
  }

  const totalMs = performance.now() - started;
  const ttftMs = firstTokenAt ? firstTokenAt - started : totalMs;
  const inputTokens = usage.input ?? estimateTokens(promptText(request.messages, request.system));
  const outputTokens = usage.output ?? estimateTokens(text);
  return {
    text,
    provider: request.provider,
    modelId: request.modelId,
    inputTokens,
    outputTokens,
    ttftMs,
    totalMs,
    tokensPerSec: outputTokens / Math.max(0.001, (totalMs - ttftMs) / 1000 || totalMs / 1000),
    costUsd: usage.cost ?? 0,
    finishReason,
  };
}

async function callAnthropic(
  request: ModelRequest,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<LLMCallResult> {
  const started = performance.now();
  let firstTokenAt: number | undefined;
  let text = "";
  let finishReason = "stop";
  const apiKey = request.apiKey ?? settings.anthropicApiKey;
  if (!apiKey) throw new Error("Anthropic API key is not configured. Add it in Settings → Providers.");

  const system =
    (request.system ??
      request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n")) +
    (request.jsonMode && request.responseSchema
      ? `\n\nReturn only valid JSON that conforms exactly to this JSON Schema:\n${JSON.stringify(
          request.responseSchema,
        )}`
      : "");
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));

  const res = await fetch(`${normaliseBase(request.baseUrl ?? "https://api.anthropic.com")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: request.modelId,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.2,
      system: system || undefined,
      messages,
      stream: request.stream !== false,
    }),
    signal: request.signal ?? AbortSignal.timeout(request.timeoutMs ?? 8 * 60_000),
    cache: "no-store",
  });
  if (!res.ok) await throwProviderError("anthropic", res);

  let inputTokens = 0;
  let outputTokens = 0;
  if (request.stream !== false && res.body) {
    await consumeSse(res, (payload) => {
      try {
        const event = JSON.parse(payload) as {
          type?: string;
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          delta?: { type?: string; text?: string; stop_reason?: string };
          usage?: { output_tokens?: number };
        };
        if (event.type === "message_start") {
          inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
          outputTokens = event.message?.usage?.output_tokens ?? outputTokens;
        }
        if (event.type === "content_block_delta" && event.delta?.text) {
          if (firstTokenAt === undefined) firstTokenAt = performance.now();
          text += event.delta.text;
          request.onToken?.(event.delta.text, text);
        }
        if (event.type === "message_delta") {
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          finishReason = event.delta?.stop_reason ?? finishReason;
        }
      } catch {
        // ignore malformed event
      }
    });
  } else {
    const payload = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    text = (payload.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    inputTokens = payload.usage?.input_tokens ?? 0;
    outputTokens = payload.usage?.output_tokens ?? 0;
    finishReason = payload.stop_reason ?? finishReason;
    if (text) request.onToken?.(text, text);
  }

  const totalMs = performance.now() - started;
  const ttftMs = firstTokenAt ? firstTokenAt - started : totalMs;
  inputTokens ||= estimateTokens(promptText(request.messages, system));
  outputTokens ||= estimateTokens(text);
  return {
    text,
    provider: "anthropic",
    modelId: request.modelId,
    inputTokens,
    outputTokens,
    ttftMs,
    totalMs,
    tokensPerSec: outputTokens / Math.max(0.001, (totalMs - ttftMs) / 1000 || totalMs / 1000),
    costUsd: 0,
    finishReason,
  };
}

async function callGemini(
  request: ModelRequest,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<LLMCallResult> {
  const started = performance.now();
  let firstTokenAt: number | undefined;
  let text = "";
  let finishReason = "stop";
  let inputTokens = 0;
  let outputTokens = 0;
  const apiKey = request.apiKey ?? settings.geminiApiKey;
  if (!apiKey) throw new Error("Google Gemini API key is not configured. Add it in Settings → Providers.");

  const base = normaliseBase(request.baseUrl ?? "https://generativelanguage.googleapis.com");
  const stream = request.stream !== false;
  const action = stream ? "streamGenerateContent?alt=sse&key=" : "generateContent?key=";
  const endpoint = `${base}/v1beta/models/${request.modelId}:${action}${encodeURIComponent(apiKey)}`;
  const system = request.system;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxTokens ?? 4096,
        ...(request.jsonMode ? { responseMimeType: "application/json" } : {}),
        ...(request.jsonMode && request.responseSchema
          ? { responseSchema: request.responseSchema }
          : {}),
      },
    }),
    signal: request.signal ?? AbortSignal.timeout(request.timeoutMs ?? 8 * 60_000),
    cache: "no-store",
  });
  if (!res.ok) await throwProviderError("google", res);

  const consume = (payload: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  }) => {
    const delta = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
    if (delta) {
      if (firstTokenAt === undefined) firstTokenAt = performance.now();
      text += delta;
      request.onToken?.(delta, text);
    }
    finishReason = payload.candidates?.[0]?.finishReason ?? finishReason;
    inputTokens = payload.usageMetadata?.promptTokenCount ?? inputTokens;
    outputTokens = payload.usageMetadata?.candidatesTokenCount ?? outputTokens;
  };

  if (stream && res.body) {
    await consumeSse(res, (payload) => {
      try {
        consume(JSON.parse(payload));
      } catch {
        // ignore
      }
    });
  } else {
    const payload = (await res.json()) as Parameters<typeof consume>[0];
    consume(payload);
    if (text) request.onToken?.(text, text);
  }

  const totalMs = performance.now() - started;
  const ttftMs = firstTokenAt ? firstTokenAt - started : totalMs;
  inputTokens ||= estimateTokens(promptText(request.messages, system));
  outputTokens ||= estimateTokens(text);
  return {
    text,
    provider: "google",
    modelId: request.modelId,
    inputTokens,
    outputTokens,
    ttftMs,
    totalMs,
    tokensPerSec: outputTokens / Math.max(0.001, (totalMs - ttftMs) / 1000 || totalMs / 1000),
    costUsd: 0,
    finishReason,
  };
}

async function callOllama(request: ModelRequest): Promise<LLMCallResult> {
  const model: ModelInfo = {
    key: `ollama/${request.modelId}`,
    provider: "ollama",
    modelId: request.modelId,
    name: request.modelId,
    kind: "local",
    capabilities: ["completion"],
    heavy: true,
    vramEstimateMB: 20_000,
    costInputPerMTok: 0,
    costOutputPerMTok: 0,
    zeroCost: true,
    source: "ollama",
    online: true,
  };
  const result = await generateOllama({
    model,
    messages: withSystem(request.messages, request.system),
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    signal: request.signal,
    onToken: request.onToken,
    onThinking: request.onThinking,
    jsonMode: request.jsonMode,
  });
  return { ...result, provider: "ollama", modelId: request.modelId };
}

async function callOpencode(request: ModelRequest): Promise<LLMCallResult> {
  const model: ModelInfo = {
    key: `opencode/${request.modelId}`,
    provider: "opencode",
    modelId: request.modelId,
    name: request.modelId,
    kind: "cloud",
    capabilities: ["completion"],
    heavy: false,
    vramEstimateMB: 0,
    costInputPerMTok: 0,
    costOutputPerMTok: 0,
    zeroCost: true,
    source: "opencode",
    online: true,
  };
  const result = await generateOpenCode({
    model,
    messages: withSystem(request.messages, request.system),
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    signal: request.signal,
    onToken: request.onToken,
    title: request.title,
  });
  return { ...result, provider: "opencode", modelId: request.modelId };
}

export async function executeLLMCall(request: ModelRequest): Promise<LLMCallResult> {
  if (!request.modelId) throw new Error("A model id is required.");
  if (!request.messages.length) throw new Error("At least one message is required.");
  const settings = await getSettings();

  if (request.provider === "ollama") return callOllama(request);
  if (request.provider === "opencode") return callOpencode(request);
  if (OPENAI_COMPATIBLE.includes(request.provider)) {
    return callOpenAiCompatible(request, settings);
  }
  if (request.provider === "anthropic") return callAnthropic(request, settings);
  if (request.provider === "google") return callGemini(request, settings);
  throw new Error(`Unsupported provider: ${String(request.provider)}`);
}

export function modelToRequest(
  model: ModelInfo,
  input: Omit<ModelRequest, "provider" | "modelId">,
): ModelRequest {
  return { ...input, provider: model.provider, modelId: model.modelId };
}

export async function listLmStudioModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${normaliseBase(baseUrl)}/models`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as { data?: Array<{ id?: string }> };
    return (payload.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

export async function probeProvider(
  provider: ModelProvider,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<{ online: boolean; detail?: string }> {
  try {
    if (provider === "ollama") {
      const res = await fetch(`${normaliseBase(settings.ollamaUrl)}/api/version`, {
        signal: AbortSignal.timeout(1800),
      });
      if (!res.ok) return { online: false, detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { version?: string };
      return { online: true, detail: body.version };
    }
    if (provider === "lmstudio") {
      const res = await fetch(`${normaliseBase(settings.lmstudioUrl)}/models`, {
        signal: AbortSignal.timeout(1800),
      });
      if (!res.ok) return { online: false, detail: `HTTP ${res.status}` };
      return { online: true, detail: "OpenAI-compatible" };
    }
    if (provider === "opencode") {
      return { online: true, detail: "managed by OpenCode CLI" };
    }
    const key = settingsKey(settings, provider);
    return {
      online: Boolean(key),
      detail: key ? "key configured" : "missing API key",
    };
  } catch (error) {
    return { online: false, detail: String(error).slice(0, 160) };
  }
}
