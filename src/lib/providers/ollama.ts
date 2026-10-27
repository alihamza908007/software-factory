import type { ModelInfo } from "../types";
import { getSettings } from "../db";
import { getHardwareProfile } from "../system/hardware-profiler";

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  model: ModelInfo;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  onToken?: (delta: string, fullText: string) => void;
  onThinking?: (delta: string) => void;
}

export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number;
  totalMs: number;
  tokensPerSec: number;
  vramMB: number;
  costUsd: number;
  loadMs?: number;
  modelKey: string;
  provider: ModelInfo["provider"];
  rawFinish?: string;
}

export async function generateOllama(request: ProviderRequest): Promise<ProviderResult> {
  const settings = await getSettings();
  const { model } = request;
  const profile = getHardwareProfile();
  const baseUrl = settings.ollamaUrl.replace(/\/$/, "");
  const started = performance.now();
  let firstTokenAt: number | undefined;
  let text = "";
  let thinking = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let evalDurationNs = 0;
  let loadDurationNs = 0;
  let rawFinish = "stop";

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: request.signal,
    body: JSON.stringify({
      model: model.modelId,
      messages: request.messages,
      stream: true,
      keep_alive: "5m",
      ...(request.jsonMode ? { format: "json" } : {}),
      options: {
        temperature: request.temperature ?? 0.2,
        num_predict: request.maxTokens ?? 4096,
        num_ctx: Math.min(model.contextLength ?? profile.contextWindow, profile.contextWindow),
        num_thread: profile.threadCount,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 800) || res.statusText}`);
  }
  if (!res.body) throw new Error("Ollama returned no response body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk: {
          message?: { content?: string; thinking?: string };
          done?: boolean;
          done_reason?: string;
          prompt_eval_count?: number;
          eval_count?: number;
          eval_duration?: number;
          load_duration?: number;
        };
        try {
          chunk = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (chunk.message?.thinking) {
          thinking += chunk.message.thinking;
          request.onThinking?.(chunk.message.thinking);
        }
        if (chunk.message?.content) {
          if (!firstTokenAt) firstTokenAt = performance.now();
          text += chunk.message.content;
          request.onToken?.(chunk.message.content, text);
        }
        if (chunk.done) {
          inputTokens = chunk.prompt_eval_count ?? 0;
          outputTokens = chunk.eval_count ?? 0;
          evalDurationNs = chunk.eval_duration ?? 0;
          loadDurationNs = chunk.load_duration ?? 0;
          rawFinish = chunk.done_reason ?? "stop";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const totalMs = performance.now() - started;
  const ttftMs = firstTokenAt ? firstTokenAt - started : totalMs;
  if (!outputTokens) {
    outputTokens = Math.max(1, Math.round(text.length / 4));
  }
  if (!inputTokens) {
    inputTokens = Math.max(
      1,
      Math.round(request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4),
    );
  }
  const tokensPerSec =
    evalDurationNs > 0
      ? outputTokens / (evalDurationNs / 1_000_000_000)
      : totalMs > 0
        ? outputTokens / Math.max(0.001, (totalMs - ttftMs) / 1000)
        : 0;

  return {
    text,
    inputTokens,
    outputTokens,
    ttftMs,
    totalMs,
    tokensPerSec,
    vramMB: model.vramEstimateMB,
    costUsd: 0,
    loadMs: loadDurationNs ? loadDurationNs / 1_000_000 : undefined,
    modelKey: model.key,
    provider: "ollama",
    rawFinish,
  };
}
