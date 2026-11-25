import { getThread } from "@/lib/data/db";
import { chatEvents } from "@/lib/data/chat-events";
import { sseChunk, sseHeaders } from "@/lib/core/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const thread = await getThread(id);
  if (!thread) return new Response("Thread not found", { status: 404 });

  const url = new URL(request.url);
  const since = Number(
    url.searchParams.get("since") ?? request.headers.get("last-event-id") ?? 0,
  );
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, sequence?: number) => {
        if (closed) return;
        try {
          controller.enqueue(sseChunk(event, data, sequence));
        } catch {
          closed = true;
        }
      };

      const replay =
        Number.isFinite(since) && since > 0
          ? chatEvents.since(id, since)
          : chatEvents.backlog(id);
      for (const item of replay) send(item.event.type, item.event, item.sequence);

      const replayDone = replay.some((item) => item.event.type === "done");
      if (replayDone) {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      unsubscribe = chatEvents.subscribe(id, (event, sequence) => {
        if (closed) return;
        send(event.type, event, sequence);
        if (event.type === "done") {
          setTimeout(() => {
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          }, 100);
        }
      });

      heartbeat = setInterval(() => {
        if (!closed) send("ping", { at: Date.now() });
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
