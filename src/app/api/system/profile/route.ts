import { json } from "@/lib/core/api";
import { getHardwareProfile } from "@/lib/runtime/system/hardware-profiler";
import { resourceQueue } from "@/lib/runtime/queue/resource-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = getHardwareProfile();
  const resources = await resourceQueue.snapshot();
  return json({ profile, resources });
}
