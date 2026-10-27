import { apiError, json } from "@/lib/api";
import { getActiveTopology, listAgents, listProjects, listRuns } from "@/lib/db";
import { startRun } from "@/lib/orchestrator/engine";
import { validateCanvasTopology } from "@/lib/canvas/topology";
import type { CanvasTopology } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
    const [runs, projects] = await Promise.all([listRuns(limit), listProjects()]);
    return json({ runs, projects: projects.map((project) => ({ id: project.id, name: project.name })) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      projectId?: string;
      prompt?: string;
      maxHealAttempts?: number;
      allowConcurrency?: boolean;
      pushToGitHub?: boolean;
      pipelineTopology?: CanvasTopology;
    };
    if (!body.projectId) throw new Error("projectId is required.");
    if (!body.prompt?.trim()) throw new Error("A build brief is required.");
    // Explicit topology wins; otherwise use the server-activated DAG so a
    // scheduled/API launch cannot silently fall back to the legacy phases.
    const topology = body.pipelineTopology ?? (await getActiveTopology()) ?? undefined;
    if (topology) {
      const agents = await listAgents();
      const validation = validateCanvasTopology(topology, agents);
      if (!validation.ok) throw new Error(`Invalid active pipeline: ${validation.errors.join(" ")}`);
    }
    const run = await startRun({
      projectId: body.projectId,
      prompt: body.prompt.trim(),
      maxHealAttempts: body.maxHealAttempts,
      allowConcurrency: body.allowConcurrency,
      pushToGitHub: body.pushToGitHub,
      pipelineTopology: topology,
    });
    return json({ run }, { status: 202 });
  } catch (error) {
    return apiError(error, 400);
  }
}
