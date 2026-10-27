import { appendMetric, getAgent, getSettings, listAgents } from "../db";
import { resourceQueue } from "../queue/resource-manager";
import type { Agent, AgentMetric, ModelInfo, ResourceReservation } from "../types";
import { uid } from "../utils";
import { getModel } from "./catalog";
import type { ProviderMessage, ProviderResult } from "./ollama";
import { executeLLMCall } from "../llm/universal-provider";
import { injectAgentMemory } from "../mesh/agent-memory";
import { recordTokenUsage } from "../mesh/analytics";
import { agentRosterPrompt } from "../mesh/router";

export interface GenerateOptions {
  agent: Agent;
  messages: ProviderMessage[];
  purpose: string;
  runId?: string;
  projectDir?: string;
  signal?: AbortSignal;
  priority?: number;
  maxTokens?: number;
  onToken?: (delta: string, fullText: string) => void;
  onThinking?: (delta: string) => void;
  onStatus?: (status: {
    stage: "queued" | "running" | "fallback" | "retry";
    message: string;
    modelKey: string;
  }) => void;
  allowFallbackOnError?: boolean;
  persistMetric?: boolean;
}

const BEHAVIORAL_GUARDRAILS = [
  "STRICT BEHAVIORAL GUARDRAILS (apply to every response):",
  "ZERO HALLUCINATION OF HANDLES — never invent or alter an @handle. Only address peers present in the live injected roster. If no roster agent fits, describe the missing capability without inventing a recipient.",
  "NO SCOPE CREEP — execute only the objective in the TaskContract. If you find an out-of-scope issue, emit a separate `SCOPE_ADVISORY: <one-sentence finding>` line and continue the assigned task; do not expand the current task to fix it.",
  "ACTIONABLE COMMUNICATION — every message must ask a clarifying question with options, report a verified metric/runtime fact, or deliver a pointer-based artifact handoff. No conversational filler.",
].join("\n");

function isLocalProvider(provider: ModelInfo["provider"]): boolean {
  return provider === "ollama" || provider === "lmstudio";
}

export interface GenerateOutcome {
  result: ProviderResult;
  model: ModelInfo;
  reservation: ResourceReservation;
  metric: AgentMetric;
  fellBack: boolean;
  fallbackReason?: string;
}

async function resolveFallback(
  agent: Agent,
  primary: ModelInfo,
  allowCloud: boolean,
): Promise<ModelInfo | undefined> {
  const settings = await getSettings();
  const keys = [agent.fallbackModelKey, settings.fallbackModelKey].filter(Boolean) as string[];
  for (const key of keys) {
    if (key === primary.key) continue;
    const model = await getModel(key);
    if (!model) continue;
    if (!isLocalProvider(model.provider) && !allowCloud) continue;
    return model;
  }
  return undefined;
}

async function callProvider(
  model: ModelInfo,
  options: GenerateOptions,
): Promise<ProviderResult> {
  // Epigenetic memory is injected at the narrowest shared point so every
  // caller (chat, SDLC, canvas, negociator, validator) receives the same
  // self-learned constraints without duplicating prompt plumbing.
  const [rememberedMessages, activeAgents] = await Promise.all([
    injectAgentMemory(options.agent.id, options.messages),
    listAgents(),
  ]);
  const messages = [
    {
      role: "system" as const,
      content: `${agentRosterPrompt(activeAgents)}\n\n${BEHAVIORAL_GUARDRAILS}`,
    },
    ...rememberedMessages,
  ];
  const result = await executeLLMCall({
    provider: model.provider,
    modelId: model.modelId,
    messages,
    temperature: options.agent.temperature,
    maxTokens: Math.min(options.agent.maxTokens, options.maxTokens ?? options.agent.maxTokens),
    signal: options.signal,
    onToken: options.onToken,
    onThinking: options.onThinking,
    title: `${options.agent.name} · ${options.purpose}`.slice(0, 80),
  });
  const computedCost =
    result.costUsd ||
    (result.inputTokens / 1_000_000) * model.costInputPerMTok +
      (result.outputTokens / 1_000_000) * model.costOutputPerMTok;
  return {
    text: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    ttftMs: result.ttftMs,
    totalMs: result.totalMs,
    tokensPerSec: result.tokensPerSec,
    vramMB: model.kind === "local" ? model.vramEstimateMB : 0,
    costUsd: model.zeroCost ? 0 : computedCost,
    modelKey: model.key,
    provider: model.provider,
    rawFinish: result.finishReason,
  };
}

export async function generateWithAgent(options: GenerateOptions): Promise<GenerateOutcome> {
  const settings = await getSettings();
  // Resolve the current persisted configuration for every generation. Long
  // running DAGs therefore observe model hot-swaps on their next node.
  const activeOptions = {
    ...options,
    agent: (await getAgent(options.agent.id)) ?? options.agent,
  };
  activeOptions.agent = {
    ...activeOptions.agent,
    maxTokens: Math.min(activeOptions.agent.maxTokens, options.maxTokens ?? activeOptions.agent.maxTokens),
  };
  const primary = await getModel(activeOptions.agent.modelKey);
  if (!primary) {
    throw new Error(
      `Model "${activeOptions.agent.modelKey}" is not available. Choose another model for ${activeOptions.agent.name}.`,
    );
  }

  const fallback = await resolveFallback(
    activeOptions.agent,
    primary,
    settings.allowCloudFallback,
  );
  const started = Date.now();

  let reservation: ResourceReservation;
  try {
    reservation = await resourceQueue.acquire({
      model: primary,
      fallbackModel: fallback,
      agentId: activeOptions.agent.id,
      agentName: activeOptions.agent.name,
      label: options.purpose,
      priority: options.priority,
      allowConcurrency: activeOptions.agent.allowConcurrency,
    });
  } catch (error) {
    // The VRAM manager could not place the job. If the agent has a cloud fallback, use it.
    if (fallback && !isLocalProvider(fallback.provider)) {
      reservation = await resourceQueue.acquire({
        model: fallback,
        agentId: activeOptions.agent.id,
        agentName: activeOptions.agent.name,
        label: options.purpose,
        priority: options.priority,
        allowConcurrency: true,
      });
      reservation.fallbackReason = `Local queue unavailable: ${String(error)}`;
    } else {
      throw error;
    }
  }

  const queuedMs = (reservation.startedAt ?? Date.now()) - reservation.enqueuedAt;
  let effective = (await getModel(reservation.modelKey)) ?? primary;
  let fellBack = effective.key !== primary.key;
  let fallbackReason = reservation.fallbackReason;

  if (fellBack) {
    activeOptions.onStatus?.({
      stage: "fallback",
      message:
        fallbackReason ??
        `Routed from ${primary.name} to ${effective.name} to stay inside the local VRAM budget.`,
      modelKey: effective.key,
    });
  } else {
    activeOptions.onStatus?.({
      stage: "running",
      message:
        effective.kind === "local"
          ? `Local generation on ${effective.name} · ${(effective.vramEstimateMB / 1024).toFixed(1)} GB reserved`
          : `Cloud generation on ${effective.name}`,
      modelKey: effective.key,
    });
  }

  let result: ProviderResult | undefined;
  let lastError: unknown;

  try {
    try {
      result = await callProvider(effective, activeOptions);
    } catch (error) {
      lastError = error;
      const isAbort =
        error instanceof DOMException && error.name === "AbortError";
      if (isAbort) throw error;
      if (
        activeOptions.allowFallbackOnError !== false &&
        fallback &&
        fallback.key !== effective.key &&
        (isLocalProvider(fallback.provider) || settings.allowCloudFallback)
      ) {
        resourceQueue.release(reservation);
        activeOptions.onStatus?.({
          stage: "retry",
          message: `${effective.name} failed (${String(error).slice(0, 140)}). Retrying on ${fallback.name}.`,
          modelKey: fallback.key,
        });
        reservation = await resourceQueue.acquire({
          model: fallback,
          agentId: activeOptions.agent.id,
          agentName: activeOptions.agent.name,
          label: `${options.purpose} · recovery`,
          priority: options.priority,
          allowConcurrency: true,
        });
        effective = (await getModel(reservation.modelKey)) ?? fallback;
        fellBack = true;
        fallbackReason = `Primary model failed: ${String(error).slice(0, 200)}`;
        result = await callProvider(effective, activeOptions);
      } else {
        throw error;
      }
    }
  } catch (error) {
    lastError = error;
    throw error;
  } finally {
    resourceQueue.release(reservation);
  }

  if (!result) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const metric: AgentMetric = {
    id: uid("met"),
    agentId: activeOptions.agent.id,
    agentName: activeOptions.agent.name,
    modelKey: effective.key,
    provider: effective.provider,
    ttftMs: Math.round(result.ttftMs),
    totalMs: Math.round(result.totalMs),
    tokensPerSec: Number(result.tokensPerSec.toFixed(2)),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: Number(result.costUsd.toFixed(6)),
    vramMB: result.vramMB,
    queuedMs: Math.max(0, Math.round(queuedMs)),
    fellBack,
    fallbackReason,
    runId: activeOptions.runId,
    createdAt: Date.now(),
  };

  if (activeOptions.persistMetric !== false) {
    await appendMetric(metric);
  }
  await recordTokenUsage(
    activeOptions.agent.id,
    result.inputTokens + result.outputTokens,
  ).catch(() => undefined);

  return {
    result,
    model: effective,
    reservation,
    metric,
    fellBack,
    fallbackReason,
  };
}

export async function pickModelForRole(roleHint: string): Promise<ModelInfo | undefined> {
  const settings = await getSettings();
  const { models } = await import("./catalog").then((module) => module.listModels());
  const offline = models.find(
    (model) =>
      model.provider === "opencode" &&
      /deepseek|longcat|flash/i.test(model.name) &&
      model.online,
  );
  if (roleHint === "local" || roleHint === "code") {
    return models.find((model) => model.kind === "local" && model.heavy);
  }
  return offline ?? (await getModel(settings.fallbackModelKey));
}
