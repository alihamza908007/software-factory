import { json } from "@/lib/core/api";
import { getThread } from "@/lib/data/db";
import { isChatJobActive, listChatJobs } from "@/lib/chat/jobs";
import { startChatTurn } from "@/lib/chat/turn-engine";
import type { ChatThread } from "@/lib/core/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Jobs registry for a thread: the active turn (if any) plus history-free
 * state so a client can wake a running turn later. "Wake" = calling
 * `POST /api/threads/[id]/jobs` again — it starts a turn if none is running
 * and returns the current state either way.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const thread = await getThread(id);
  if (!thread) return json({ error: "Thread not found." }, { status: 404 });
  const running = isChatJobActive(id);
  return json({
    threadId: id,
    running,
    jobs: listChatJobs([id]).map((job) => ({
      threadId: job.threadId,
      startedAt: job.startedAt,
      status: job.status,
    })),
  });
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const thread = await getThread(id);
  if (!thread) return json({ error: "Thread not found." }, { status: 404 });
  // Wake: if a turn is already running, just report it; otherwise spawn one
  // from the thread's last user message. The client then attaches via the
  // events stream (which replays from the beginning).
  if (isChatJobActive(id)) return json({ threadId: id, running: true });
  const lastUser = thread.messages.findLast((message) => message.role === "user");
  if (!lastUser) return json({ threadId: id, running: false });
  const { threadId, running } = await startChatTurn({
    threadId: id,
    message: lastUser.content,
  });
  return json({ threadId, running });
}
