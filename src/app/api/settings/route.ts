import { apiError, json } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/db";
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
    hasOpencodePassword: Boolean(settings.opencodePassword),
    hasGithubToken: Boolean(settings.githubToken),
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
    };
    const current = await getSettings();
    const patch: Partial<FactorySettings> = {};

    const numericKeys: Array<keyof FactorySettings> = [
      "vramBudgetMB",
      "reserveMB",
      "maxConcurrentHeavy",
      "vramQueueTimeoutMs",
      "maxHealAttempts",
      "commandTimeoutMs",
      "maxHandoffDepth",
    ];
    const stringKeys: Array<keyof FactorySettings> = [
      "ollamaUrl",
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

    const merged = { ...current, ...patch };
    if (merged.reserveMB >= merged.vramBudgetMB) {
      throw new Error("Reserve memory must be smaller than the VRAM budget.");
    }
    if (merged.maxConcurrentHeavy < 1 || merged.maxConcurrentHeavy > 4) {
      throw new Error("Heavy model concurrency must be between 1 and 4.");
    }
    if (merged.maxHealAttempts < 0 || merged.maxHealAttempts > 8) {
      throw new Error("Self-heal attempts must be between 0 and 8.");
    }
    if (merged.vramQueueTimeoutMs < 5_000) {
      throw new Error("Queue timeout must be at least 5 seconds.");
    }

    const next = await updateSettings(patch);
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
