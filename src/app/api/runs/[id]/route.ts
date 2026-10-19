import { apiError, json } from "@/lib/api";
import { getRun } from "@/lib/db";
import { cancelRun, isRunActive, rerunPhase } from "@/lib/orchestrator/engine";
import type { PhaseId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const run = await getRun(id);
    if (!run) return json({ error: "Run not found." }, { status: 404 });
    return json({ run, active: isRunActive(id) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { action?: string; phaseId?: PhaseId };
    if (body.action === "cancel") {
      const cancelled = await cancelRun(id);
      return json({ ok: cancelled });
    }
    if (body.action === "rerun" && body.phaseId) {
      const run = await rerunPhase(id, body.phaseId);
      return json({ run });
    }
    return json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return json({ ok: await cancelRun(id) });
  } catch (error) {
    return apiError(error);
  }
}
