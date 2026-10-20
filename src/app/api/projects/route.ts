import { apiError, json } from "@/lib/api";
import { listProjects, listRuns, saveProject } from "@/lib/db";
import type { Project } from "@/lib/types";
import { scaffoldProject, workspacePathFor } from "@/lib/workspace";
import { createProjectShortcut } from "@/lib/desktop";
import { slugify, uid } from "@/lib/utils";
import { promises as fs } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [projects, runs] = await Promise.all([listProjects(), listRuns(200)]);
    return json({
      projects: projects
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((project) => ({
          ...project,
          runCount: runs.filter((run) => run.projectId === project.id).length,
          lastRun: runs.find((run) => run.projectId === project.id) ?? null,
        })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      description?: string;
      stack?: Project["stack"];
    };
    if (!body.name?.trim()) throw new Error("Project name is required.");
    const stack = body.stack ?? "node";
    if (!["node", "python", "next"].includes(stack)) throw new Error("Unsupported stack.");
    const id = uid("prj");
    const slug = slugify(body.name) || "project";
    const workspacePath = workspacePathFor(slug, id);
    await fs.mkdir(workspacePath, { recursive: true });
    await scaffoldProject(workspacePath, stack, body.name.trim());
    const shortcut = await createProjectShortcut(body.name.trim(), workspacePath, id);
    if (shortcut.error) {
      console.warn(`[factory] desktop shortcut skipped: ${shortcut.error}`);
    }
    const now = Date.now();
    const project: Project = {
      id,
      name: body.name.trim(),
      slug,
      description: body.description?.trim() || body.name.trim(),
      stack,
      workspacePath,
      desktopLink: shortcut.path,
      desktopLinkError: shortcut.error,
      createdAt: now,
      updatedAt: now,
      gitInitialized: false,
    };
    await saveProject(project);
    return json({ project }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
