import { apiError, readJson, sseChunk, sseHeaders } from "@/lib/api";
import { validateCanvasTopology } from "@/lib/canvas/topology";
import { executeCanvasTopology } from "@/lib/orchestrator/scheduler";
import type { CanvasTopology } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

interface CanvasBody {
  action?: "validate" | "run";
  topology?: CanvasTopology;
}

export async function POST(request: Request) {
  let body: CanvasBody;
  try {
    body = await readJson<CanvasBody>(request);
  } catch (error) {
    return apiError(error, 400);
  }
  if (!body.topology?.nodes) return apiError(new Error("A canvas topology is required."), 400);

  const validation = validateCanvasTopology(body.topology);
  if (body.action !== "run") return Response.json({ validation });

  if (!validation.ok) {
    return apiError(new Error(`Invalid canvas: ${validation.errors.join(" ")}`), 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseChunk(event, data));
        } catch {
          closed = true;
        }
      };
      try {
        const result = await executeCanvasTopology(body.topology!, {
          signal: request.signal,
          emit: (event) => send("canvas", event),
        });
        send("done", { result });
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : String(error) });
        send("done", { ok: false });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      // request.signal aborts provider calls
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
