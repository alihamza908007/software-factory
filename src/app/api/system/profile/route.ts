import { json } from "@/lib/api";
import { getHardwareProfile } from "@/lib/system/hardware-profiler";
import { resourceQueue } from "@/lib/queue/resource-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = getHardwareProfile();
  const resources = await resourceQueue.snapshot();
  return json({ profile, resources });
}
