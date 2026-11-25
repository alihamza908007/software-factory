import { apiError, json } from "@/lib/core/api";
import { getSettings, listAgents, updateSettings } from "@/lib/data/db";
import { syncEnvFile } from "@/lib/core/env-sync";
import { discoverOpenCodeUrl, invalidateModelCache } from "@/lib/providers/catalog";
import { resourceQueue } from "@/lib/runtime/queue/resource-manager";
import type { FactorySettings } from "@/lib/core/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function wholeNumber(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
}

function httpUrl(value: string, label: string): string {
  if (!value) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must start with http:// or https://.`);
  }
  return value;
}

function publicSettings(settings: FactorySettings) {
  return {
    ...settings,
    opencodePassword: "",
    githubToken: "",
    openrouterApiKey: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    geminiApiKey: "",
    hasOpencodePassword: Boolean(settings.opencodePassword),
    hasGithubToken: Boolean(settings.githubToken),
    hasOpenrouterApiKey: Boolean(settings.openrouterApiKey),
    hasAnthropicApiKey: Boolean(settings.anthropicApiKey),
    hasOpenaiApiKey: Boolean(settings.openaiApiKey),
    hasGeminiApiKey: Boolean(settings.geminiApiKey),
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const opencodeUrl = await discoverOpenCodeUrl();
    return json({
      settings: publicSettings(settings),
      resolvedOpencodeUrl: opencodeUrl,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as Partial<FactorySettings> & {
      clearOpencodePassword?: boolean;
      clearGithubToken?: boolean;
      clearOpenrouterApiKey?: boolean;
      clearAnthropicApiKey?: boolean;
      clearOpenaiApiKey?: boolean;
      clearGeminiApiKey?: boolean;
    };
    const current = await getSettings();
    const patch: Partial<FactorySettings> = {};

    const numericKeys: Array<keyof FactorySettings> = [
      "vramBudgetMB",
      "reserveMB",
      "maxConcurrentHeavy",
      "maxConcurrentLight",
      "vramQueueTimeoutMs",
      "maxHealAttempts",
      "commandTimeoutMs",
      "maxHandoffDepth",
      "guardrailThreshold",
      "guardrailMaxRetries",
      "deadLoopWindow",
      "deadLoopThreshold",
    ];
    const stringKeys: Array<keyof FactorySettings> = [
      "ollamaUrl",
      "lmstudioUrl",
      "opencodeUrl",
      "fallbackModelKey",
      "gitAuthorName",
      "gitAuthorEmail",
      "githubOwner",
      "githubRepo",
      "githubBaseBranch",
      "defaultAgentId",
    ];
    const booleanKeys: Array<keyof FactorySettings> = [
      "allowConcurrentLight",
      "allowCloudFallback",
      "allowExecution",
      "autoCommit",
      "githubCreateRepo",
      "autoHandoff",
    ];

    for (const key of stringKeys) {
      if (typeof body[key] === "string") {
        (patch as Record<string, unknown>)[key] = (body[key] as string).trim();
      }
    }
    for (const key of numericKeys) {
      if (typeof body[key] === "number" && Number.isFinite(body[key])) {
        (patch as Record<string, unknown>)[key] = body[key];
      }
    }
    for (const key of booleanKeys) {
      if (typeof body[key] === "boolean") {
        (patch as Record<string, unknown>)[key] = body[key];
      }
    }

    if (body.clearOpencodePassword) patch.opencodePassword = "";
    else if (typeof body.opencodePassword === "string" && body.opencodePassword.trim()) {
      patch.opencodePassword = body.opencodePassword.trim();
    }
    if (body.clearGithubToken) patch.githubToken = "";
    else if (typeof body.githubToken === "string" && body.githubToken.trim()) {
      patch.githubToken = body.githubToken.trim();
    }

    const apiKeyFields: Array<[keyof FactorySettings, keyof typeof body]> = [
      ["openrouterApiKey", "clearOpenrouterApiKey"],
      ["anthropicApiKey", "clearAnthropicApiKey"],
      ["openaiApiKey", "clearOpenaiApiKey"],
      ["geminiApiKey", "clearGeminiApiKey"],
    ];
    for (const [key, clearKey] of apiKeyFields) {
      if (body[clearKey]) {
        (patch as Record<string, unknown>)[key] = "";
      } else if (typeof body[key] === "string" && (body[key] as string).trim()) {
        (patch as Record<string, unknown>)[key] = (body[key] as string).trim();
      }
    }

    const merged = { ...current, ...patch };
    wholeNumber(merged.vramBudgetMB, "Unified memory budget", 4_096, 131_072);
    wholeNumber(merged.reserveMB, "Reserved memory", 1_024, 32_768);
    if (merged.reserveMB >= merged.vramBudgetMB) {
      throw new Error("Reserve memory must be smaller than the VRAM budget.");
    }
    wholeNumber(merged.maxConcurrentHeavy, "Heavy model concurrency", 1, 4);
    wholeNumber(merged.maxConcurrentLight, "Light model concurrency", 1, 4);
    wholeNumber(merged.vramQueueTimeoutMs, "Queue timeout", 5_000, 600_000);
    wholeNumber(merged.maxHealAttempts, "Self-heal attempts", 0, 8);
    wholeNumber(merged.commandTimeoutMs, "Command timeout", 10_000, 900_000);
    wholeNumber(merged.maxHandoffDepth, "Max handoff depth", 0, 5);
    wholeNumber(merged.guardrailThreshold, "Guardrail threshold", 0, 100);
    wholeNumber(merged.guardrailMaxRetries, "Corrective retries", 0, 4);
    wholeNumber(merged.deadLoopWindow, "Dead-loop trace window", 3, 12);
    wholeNumber(merged.deadLoopThreshold, "Dead-loop threshold", 2, 8);
    httpUrl(merged.ollamaUrl, "Ollama URL");
    httpUrl(merged.lmstudioUrl, "LM Studio URL");
    httpUrl(merged.opencodeUrl, "OpenCode URL");

    if (merged.defaultAgentId) {
      const agents = await listAgents();
      const target = agents.find((agent) => agent.id === merged.defaultAgentId);
      if (!target) throw new Error("The default agent no longer exists. Pick another agent.");
      if (!target.enabled) throw new Error("The default agent is disabled. Enable it or pick another agent.");
    }

    const next = await updateSettings(patch);
    await syncEnvFile(next, Object.keys(patch) as Array<keyof FactorySettings>).catch(
      () => undefined,
    );
    invalidateModelCache();
    await resourceQueue.refreshPolicy();
    return json({
      settings: publicSettings(next),
      resolvedOpencodeUrl: await discoverOpenCodeUrl(),
    });
  } catch (error) {
    return apiError(error, 400);
  }
}
