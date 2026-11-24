import { apiError, json, readJson, sseChunk, sseHeaders } from "@/lib/core/api";
import { runEvents } from "@/lib/core/events";
import { createPhases } from "@/lib/core/constants";
import { isProjectBusy } from "@/lib/core/errors";
import { defaultCanvasTopology, validateCanvasTopology } from "@/lib/pipeline/topology";
import {
  clearActiveTopology,
  getCanvasSnapshot,
  getProject,
  getRun,
  listAgents,
  saveCanvasTopology,
  saveProject,
  saveRun,
  updateRun,
} from "@/lib/data/db";
import { listWorkspaceFiles } from "@/lib/data/workspace";
import { readGitState } from "@/lib/runtime/tools/git";
import { executeCanvasTopology, type DagExecutionResult } from "@/lib/pipeline/scheduler";
import { meshBus } from "@/lib/mesh/event-bus";
import { acquireProjectLock, releaseProjectLock } from "@/lib/pipeline/engine/shared";
import type { CanvasTopology, PhaseId, PhaseStatus, Project, Run } from "@/lib/core/types";
import { uid } from "@/lib/core/utils";

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

async function startCanvasRun(
  project: Project | undefined,
  topology: CanvasTopology,
  prompt: string,
): Promise<Run> {
  const run: Run = {
    id: uid("run"),
    projectId: project?.id ?? "",
    projectName: project?.name ?? "Ad-hoc canvas DAG",
    prompt: prompt.trim() || "Ad-hoc canvas DAG execution.",
    status: "running",
    currentPhase: "implementation",
    phases: createPhases().map((phase) =>
      phase.id === "requirements" || phase.id === "architecture"
        ? { ...phase, status: "skipped" as const, progress: 100, completedAt: Date.now() }
        : phase,
    ),
    git: { initialized: false, commits: [], dirtyFiles: 0, pushed: false, branch: dagBranchFor(project) },
    artifacts: { fileTree: [] },
    options: {
      engine: "canvas",
      pipelineTopology: topology,
      allowConcurrency: true,
      pushToGitHub: false,
      maxHealAttempts: 3,
    },
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (project) acquireProjectLock(project.id, run.id);
  try {
    await saveRun(run);
    if (project) await saveProject({ ...project, lastRunId: run.id, updatedAt: Date.now() });
  } catch (error) {
    if (project) releaseProjectLock(project.id, run.id);
    throw error;
  }
  runEvents.publish(run.id, { type: "snapshot", run });
  return run;
}

function dagBranchFor(project: Project | undefined): string | undefined {
  // Labelled as the DAG label (the standard engine rewrites it on a run
  // branch); it stays honest because an ad-hoc DAG may not commit anything.
  return project?.slug ? `${project.slug}-dag` : undefined;
}

async function finalizeCanvasRun(
  runId: string,
  project: Project | undefined,
  result: DagExecutionResult,
): Promise<void> {
  const root = project?.workspacePath ?? "";
  const failed = result.nodes.filter((node) => node.status === "failed" || node.status === "blocked");
  const finalGit = await readGitState(root);
  const finalFiles = await listWorkspaceFiles(root, 300);
  await updateRun(runId, (item) => {
    item.status = result.ok ? "passed" : "failed";
    item.completedAt = Date.now();
    item.currentPhase = null;
    if (item.git) item.git = { ...item.git, ...finalGit };
    item.artifacts.fileTree = finalFiles;
    item.artifacts.summary = `Ad-hoc canvas DAG · ${result.nodes.length} node(s)` +
      (failed.length ? ` · ${failed.length} blocked/failed` : "") +
      ` · ${finalFiles.length} files`;
    if (!result.ok && failed.length) item.error = `Canvas DAG: ${failed.map((node) => node.label).join(", ")}`;
    const apply = (phaseId: PhaseId, status: PhaseStatus) => {
      const phase = item.phases.find((entry) => entry.id === phaseId);
      if (!phase) return;
      phase.status = status;
      phase.progress = status === "pending" ? 5 : status === "running" ? 50 : status === "passed" ? 100 : 0;
      if (status === "passed" || status === "failed") {
        phase.completedAt = Date.now();
      }
    };
    apply("implementation", result.ok ? "passed" : "failed");
    apply("testing", result.ok ? "passed" : "pending");
    apply("deployment", result.ok ? "passed" : "skipped");
  });
  const finalRun = await getRun(runId);
  if (finalRun) runEvents.publish(runId, { type: "snapshot", run: finalRun });
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

  let run: Run;
  try {
    run = await startCanvasRun(project, body.topology!, body.initialInput ?? "");
  } catch (error) {
    return apiError(error, isProjectBusy(error) ? 409 : 400);
  }
  const runId = run.id;
  meshBus.publish({
    type: "CANVAS_RUN_STARTED",
    source: "Canvas",
    runId,
    projectId: project?.id,
    severity: "info",
    title: "Canvas DAG started",
    message: `${body.topology!.nodes.length} nodes · ${body.topology!.edges.length} edges${project ? ` · ${project.name}` : ""}.`,
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
        await finalizeCanvasRun(runId, project, result);
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
        try {
          await updateRun(runId, (item) => {
            item.status = "failed";
            item.error = message.slice(0, 2000);
            item.currentPhase = null;
          });
          const finalRun = await getRun(runId);
          if (finalRun) runEvents.publish(runId, { type: "snapshot", run: finalRun });
        } catch {
          // best effort
        }
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
        if (project) releaseProjectLock(project.id, runId);
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
