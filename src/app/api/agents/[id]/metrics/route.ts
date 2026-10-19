import { apiError, json } from "@/lib/api";
import { getAgent, listMetrics } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const agent = await getAgent(id);
    if (!agent) return json({ error: "Agent not found." }, { status: 404 });
    const url = new URL(request.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
    const metrics = await listMetrics(id, limit);
    const average = metrics.length
      ? {
          ttftMs: metrics.reduce((sum, item) => sum + item.ttftMs, 0) / metrics.length,
          totalMs: metrics.reduce((sum, item) => sum + item.totalMs, 0) / metrics.length,
          tokensPerSec:
            metrics.reduce((sum, item) => sum + item.tokensPerSec, 0) / metrics.length,
          costUsd: metrics.reduce((sum, item) => sum + item.costUsd, 0),
          vramMB: metrics.reduce((sum, item) => sum + item.vramMB, 0) / metrics.length,
        }
      : null;
    return json({ agent, metrics, average });
  } catch (error) {
    return apiError(error);
  }
}
