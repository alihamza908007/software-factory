import { json } from "@/lib/core/api";
import { getThread } from "@/lib/data/db";
import { cancelChatJob, isChatJobActive } from "@/lib/chat/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const thread = await getThread(id);
  if (!thread) return json({ error: "Thread not found." }, { status: 404 });
  const wasRunning = isChatJobActive(id);
  const cancelled = cancelChatJob(id);
  return json({ cancelled, wasRunning, running: false });
}
