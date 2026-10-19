import { getRun } from "@/lib/db";
import { runEvents } from "@/lib/events";
import { sseChunk, sseHeaders } from "@/lib/api";

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

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseChunk(event, data));
        } catch {
          closed = true;
        }
      };

      const backlog = runEvents.backlog(id);
      if (backlog.length) {
        for (const event of backlog) send(event.type, event);
      } else {
        send("snapshot", { type: "snapshot", run });
      }

      if (["passed", "failed", "cancelled", "interrupted"].includes(run.status)) {
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

      unsubscribe = runEvents.subscribe(id, (event) => {
        send(event.type, event);
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
