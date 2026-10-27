import { sseChunk, sseHeaders } from "@/lib/api";
import { getControlSnapshot } from "@/lib/mesh/controls";
import { hydrateMeshEvents, meshBus } from "@/lib/mesh/event-bus";
import { ensureValidatorRuntime } from "@/lib/mesh/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(request: Request) {
  ensureValidatorRuntime();
  await hydrateMeshEvents();
  const controls = await getControlSnapshot();
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
      const send = (event: string, data: unknown, id?: string | number) => {
        if (closed) return;
        try {
          controller.enqueue(sseChunk(event, data, id));
        } catch {
          closed = true;
        }
      };

      send("snapshot", {
        events: meshBus.backlog(180),
        statuses: meshBus.statuses(),
        controls,
        sequence: meshBus.sequenceNumber(),
        resumedFrom: Number.isFinite(resumeFrom) ? resumeFrom : 0,
        at: Date.now(),
      });

      // Replay anything the client missed between reconnects before attaching
      // the live subscriber. Duplicate ids are ignored by the client store.
      if (Number.isFinite(resumeFrom) && resumeFrom > 0) {
        for (const event of meshBus.since(resumeFrom, 200)) {
          send("mesh", event, event.sequence);
        }
      }

      unsubscribe = meshBus.subscribeAll((event) => {
        send("mesh", event, event.sequence);
      });

      heartbeat = setInterval(() => {
        send("ping", { at: Date.now() });
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
