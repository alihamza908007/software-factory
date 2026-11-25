import { apiError, json } from "@/lib/core/api";
import { isProjectBusy } from "@/lib/core/errors";
import { MAX_STORED_RUNS } from "@/lib/core/constants";
import { getActiveTopology, listAgents, listProjects, listRuns } from "@/lib/data/db";
import { startRun } from "@/lib/pipeline/engine";
import { validateCanvasTopology } from "@/lib/pipeline/topology";
import type { CanvasTopology } from "@/lib/core/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(MAX_STORED_RUNS, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
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
    if (body.prompt.trim().length > 8_000) {
      throw new Error("A build brief must be 8,000 characters or fewer.");
    }
    if (body.maxHealAttempts !== undefined) {
      if (
        !Number.isInteger(body.maxHealAttempts) ||
        body.maxHealAttempts < 0 ||
        body.maxHealAttempts > 8
      ) {
        throw new Error("Self-heal attempts must be a whole number between 0 and 8.");
      }
    }
    for (const key of ["allowConcurrency", "pushToGitHub"] as const) {
      if (body[key] !== undefined && typeof body[key] !== "boolean") {
        throw new Error(`${key} must be a boolean.`);
      }
    }
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
    return apiError(error, isProjectBusy(error) ? 409 : 400);
  }
}
