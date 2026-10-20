import { apiError, json } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/db";
import { syncEnvFile } from "@/lib/env-sync";
import { discoverOpenCodeUrl, invalidateModelCache } from "@/lib/providers/catalog";
import { resourceQueue } from "@/lib/queue/resource-manager";
import type { FactorySettings } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if (merged.reserveMB >= merged.vramBudgetMB) {
      throw new Error("Reserve memory must be smaller than the VRAM budget.");
    }
    if (merged.maxConcurrentHeavy < 1 || merged.maxConcurrentHeavy > 4) {
      throw new Error("Heavy model concurrency must be between 1 and 4.");
    }
    if (merged.maxConcurrentLight < 1 || merged.maxConcurrentLight > 4) {
      throw new Error("Light model concurrency must be between 1 and 4.");
    }
    if (merged.guardrailThreshold < 0 || merged.guardrailThreshold > 100) {
      throw new Error("Guardrail threshold must be between 0 and 100.");
    }
    if (merged.guardrailMaxRetries < 0 || merged.guardrailMaxRetries > 4) {
      throw new Error("Guardrail corrective retries must be between 0 and 4.");
    }
    if (merged.deadLoopWindow < 3 || merged.deadLoopWindow > 12) {
      throw new Error("Dead-loop trace window must be between 3 and 12 steps.");
    }
    if (merged.deadLoopThreshold < 2 || merged.deadLoopThreshold > 8) {
      throw new Error("Dead-loop threshold must be between 2 and 8 identical transitions.");
    }
    if (merged.maxHealAttempts < 0 || merged.maxHealAttempts > 8) {
      throw new Error("Self-heal attempts must be between 0 and 8.");
    }
    if (merged.vramQueueTimeoutMs < 5_000) {
      throw new Error("Queue timeout must be at least 5 seconds.");
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
