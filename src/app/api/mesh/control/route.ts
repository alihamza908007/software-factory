import { apiError, json, readJson } from "@/lib/api";
import {
  clearMeshControls,
  getControlSnapshot,
  overrideValidation,
  setAgentPaused,
} from "@/lib/mesh/controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ControlBody {
  action?: "pause" | "resume" | "override" | "reset";
  agentId?: string;
  eventId?: string;
  reason?: string;
}

export async function GET() {
  try {
    return json({ controls: await getControlSnapshot() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson<ControlBody>(request);
    if (body.action === "reset") {
      return json({ controls: await clearMeshControls() });
    }
    if (body.action === "pause" || body.action === "resume") {
      if (!body.agentId) throw new Error("agentId is required.");
      return json({
        controls: await setAgentPaused(
          body.agentId,
          body.action === "pause",
          body.reason,
        ),
      });
    }
    if (body.action === "override") {
      if (!body.eventId) throw new Error("eventId is required.");
      return json({
        controls: await overrideValidation(body.eventId, body.reason ?? "", body.agentId),
      });
    }
    throw new Error("Unknown control action.");
  } catch (error) {
    return apiError(error, 400);
  }
}
