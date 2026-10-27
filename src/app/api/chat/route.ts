import { readJson, sseChunk, sseHeaders } from "@/lib/api";
import { createThread, getThread } from "@/lib/db";
import type { ChatThread } from "@/lib/types";
import { uid } from "@/lib/utils";
import { runChatTurn, type ChatBody } from "@/lib/chat/turn-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function POST(request: Request) {
  let body: ChatBody;
  try {
    body = await readJson<ChatBody>(request);
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!body.message?.trim()) {
    return new Response(JSON.stringify({ error: "Message is required." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await runChatTurn({ body, request, controller });
    },
    cancel() {
      // request.signal handles cancellation
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
