import { apiError, json } from "@/lib/api";
import { resourceQueue } from "@/lib/queue/resource-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ snapshot: await resourceQueue.snapshot() });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE() {
  try {
    resourceQueue.reset();
    return json({ ok: true, snapshot: await resourceQueue.snapshot() });
  } catch (error) {
    return apiError(error);
  }
}
