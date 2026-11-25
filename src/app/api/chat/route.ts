import { json, readJson } from "@/lib/core/api";
import { startChatTurn, type ChatBody } from "@/lib/chat/turn-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/**
 * Launches the turn detached and returns the thread id plus `running`. The
 * client follows the same turn on GET /api/threads/[id]/events (server-side
 * replay), so drops or page reloads can reattach from the durable log.
 */
export async function POST(request: Request) {
  let body: ChatBody;
  try {
    body = await readJson<ChatBody>(request);
  } catch (error) {
    return json({ error: String(error) }, { status: 400 });
  }
  if (!body.message?.trim()) return json({ error: "Message is required." }, { status: 400 });
  try {
    const { threadId, running } = await startChatTurn(body);
    return json({ threadId, running }, { status: 202 });
  } catch (error) {
    return json({ error: String(error) }, { status: 400 });
  }
}
