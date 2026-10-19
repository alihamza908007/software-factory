import { apiError, json } from "@/lib/api";
import { listProjects, listRuns } from "@/lib/db";
import { startRun } from "@/lib/orchestrator/engine";

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
    };
    if (!body.projectId) throw new Error("projectId is required.");
    if (!body.prompt?.trim()) throw new Error("A build brief is required.");
    const run = await startRun({
      projectId: body.projectId,
      prompt: body.prompt.trim(),
      maxHealAttempts: body.maxHealAttempts,
      allowConcurrency: body.allowConcurrency,
      pushToGitHub: body.pushToGitHub,
    });
    return json({ run }, { status: 202 });
  } catch (error) {
    return apiError(error, 400);
  }
}
