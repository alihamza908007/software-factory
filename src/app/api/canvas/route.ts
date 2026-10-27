import { apiError, json, readJson, sseChunk, sseHeaders } from "@/lib/api";
import { defaultCanvasTopology, validateCanvasTopology } from "@/lib/canvas/topology";
import {
  clearActiveTopology,
  getCanvasSnapshot,
  getProject,
  listAgents,
  saveCanvasTopology,
} from "@/lib/db";
import { meshBus } from "@/lib/mesh/event-bus";
import { executeCanvasTopology } from "@/lib/orchestrator/scheduler";
import type { CanvasTopology } from "@/lib/types";
import { uid } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

interface CanvasBody {
  action?: "validate" | "run" | "save" | "activate" | "deactivate";
  topology?: CanvasTopology;
  projectId?: string;
  initialInput?: string;
  applyArtifacts?: boolean;
}

async function currentTopology(): Promise<{
  topology: CanvasTopology | null;
  active: CanvasTopology | null;
  updatedAt: number;
  validation: ReturnType<typeof validateCanvasTopology> | null;
}> {
  const snapshot = await getCanvasSnapshot();
  const agents = await listAgents();
  const topology =
    snapshot.topology ??
    (agents.length ? defaultCanvasTopology(agents) : null);
  return {
    ...snapshot,
    topology,
    validation: topology ? validateCanvasTopology(topology, agents) : null,
  };
}

export async function GET() {
  try {
    return json(await currentTopology());
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await readJson<CanvasBody>(request);
    if (body.action === "deactivate") {
      const snapshot = await clearActiveTopology();
      return json({ ...snapshot, action: "deactivate" });
    }
    if (!body.topology?.nodes) {
      throw new Error("A canvas topology is required.");
    }
    const agents = await listAgents();
    const validation = validateCanvasTopology(body.topology, agents);
    const activate = body.action === "activate";
    if (activate && !validation.ok) {
      return json(
        { error: `Canvas cannot be activated: ${validation.errors.join(" ")}`, validation },
        { status: 400 },
      );
    }
    const snapshot = await saveCanvasTopology(body.topology, activate);
    if (activate) {
      meshBus.publish({
        type: "AGENT_STATUS",
        source: "Canvas",
        severity: "info",
        title: "Execution DAG activated",
        message: `${body.topology.nodes.length} nodes will be used by autonomous runs and chat.`,
        payload: { status: "idle", detail: "Active DAG updated" },
      });
    }
    return json({ ...snapshot, action: activate ? "activate" : "save", validation });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function POST(request: Request) {
  let body: CanvasBody;
  try {
    body = await readJson<CanvasBody>(request);
  } catch (error) {
    return apiError(error, 400);
  }
  if (!body.topology?.nodes) return apiError(new Error("A canvas topology is required."), 400);

  const agents = await listAgents();
  const validation = validateCanvasTopology(body.topology, agents);
  if (body.action !== "run") return Response.json({ validation });

  if (!validation.ok) {
    return apiError(new Error(`Invalid canvas: ${validation.errors.join(" ")}`), 400);
  }
  if (body.applyArtifacts && !body.projectId) {
    return apiError(new Error("Select a project before applying canvas artifacts."), 400);
  }
  const project = body.projectId ? await getProject(body.projectId) : undefined;
  if (body.projectId && !project) {
    return apiError(new Error("Canvas project not found."), 400);
  }

  const runId = uid("canvas");
  meshBus.publish({
    type: "CANVAS_RUN_STARTED",
    source: "Canvas",
    runId,
    projectId: project?.id,
    severity: "info",
    title: "Canvas DAG started",
    message: `${body.topology.nodes.length} nodes · ${body.topology.edges.length} edges${project ? ` · ${project.name}` : ""}.`,
    payload: { topology: body.topology, projectId: project?.id, applyArtifacts: Boolean(body.applyArtifacts) },
  });

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
          projectId: project?.id,
          projectDir: project?.workspacePath,
          initialInput: body.initialInput?.trim() || undefined,
          applyArtifacts: Boolean(body.applyArtifacts),
          runId,
        });
        const failed = result.nodes.filter((node) => node.status === "failed" || node.status === "blocked");
        meshBus.publish({
          type: "CANVAS_RUN_COMPLETED",
          source: "Canvas",
          runId,
          projectId: project?.id,
          severity: result.ok ? "success" : "warning",
          title: result.ok ? "Canvas DAG passed" : "Canvas DAG finished with failures",
          message: `${result.nodes.length - failed.length}/${result.nodes.length} nodes passed in ${Math.round(result.durationMs / 1000)}s.${
            failed.length ? ` Blocked/failed: ${failed.map((node) => node.label).join(", ")}.` : ""
          }`,
          payload: { result, projectId: project?.id },
        });
        send("done", { result, runId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        meshBus.publish({
          type: "CANVAS_RUN_COMPLETED",
          source: "Canvas",
          runId,
          projectId: project?.id,
          severity: "error",
          title: "Canvas DAG crashed",
          message,
          payload: { projectId: project?.id },
        });
        send("error", { message });
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
