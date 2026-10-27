import { apiError, json } from "@/lib/api";
import { getAgent } from "@/lib/db";
import { generateWithAgent } from "@/lib/providers/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const agent = await getAgent(id);
    if (!agent) return apiError(new Error("Agent not found."), 404);
    const result = await generateWithAgent({
      agent,
      messages: [{ role: "user", content: "Reply with exactly: connection-ok" }],
      purpose: "agent model connection check",
      priority: 4,
    });
    return json({
      ok: true,
      modelKey: result.metric.modelKey,
      provider: result.metric.provider,
      latencyMs: result.metric.totalMs,
      tokensPerSec: result.metric.tokensPerSec,
      fellBack: result.metric.fellBack,
      fallbackReason: result.metric.fallbackReason,
    });
  } catch (error) {
    return apiError(error);
  }
}
