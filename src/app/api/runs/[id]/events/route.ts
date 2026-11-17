import { getRun } from "@/lib/data/db";
import { runEvents } from "@/lib/core/events";
import { sseChunk, sseHeaders } from "@/lib/core/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const run = await getRun(id);
  if (!run) return new Response("Run not found", { status: 404 });

  const url = new URL(request.url);
  const resumeFrom = Number(
    url.searchParams.get("since") ?? request.headers.get("last-event-id") ?? 0,
  );
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return;
        try {
          controller.enqueue(sseChunk(event, data, id));
        } catch {
          closed = true;
        }
      };

      const backlog = resumeFrom > 0
        ? runEvents.since(id, resumeFrom)
        : runEvents.backlog(id);
      if (backlog.length) {
        for (const item of backlog) send(item.event.type, item.event, item.sequence);
      } else {
        send("snapshot", { type: "snapshot", run }, runEvents.sequenceNumber(id));
      }

      if (["passed", "failed", "cancelled", "interrupted", "recoverable_paused"].includes(run.status)) {
        setTimeout(() => {
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        }, 250);
        return;
      }

      unsubscribe = runEvents.subscribe(id, (event, sequence) => {
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
