import { apiError, json } from "@/lib/core/api";
import { getModelCatalogue } from "@/lib/providers/catalog";
import { getSettings } from "@/lib/data/db";
import { resourceQueue } from "@/lib/runtime/queue/resource-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("refresh") === "1";
    const [catalogue, settings, resources] = await Promise.all([
      getModelCatalogue(),
      getSettings(),
      resourceQueue.snapshot(),
    ]);
    if (force) {
      const { listModels } = await import("@/lib/providers/catalog");
      const refreshed = await listModels(true);
      return json({
        ...refreshed,
        settings: {
          ollamaUrl: settings.ollamaUrl,
          vramBudgetMB: settings.vramBudgetMB,
          reserveMB: settings.reserveMB,
        },
        resources,
      });
    }
    return json({
      ...catalogue,
      settings: {
        ollamaUrl: settings.ollamaUrl,
        vramBudgetMB: settings.vramBudgetMB,
        reserveMB: settings.reserveMB,
      },
      resources,
    });
  } catch (error) {
    return apiError(error);
  }
}
