import { apiError, json } from "@/lib/api";
import { deleteProject, getProject, listRuns } from "@/lib/db";
import { listWorkspaceFiles } from "@/lib/workspace";
import { removeProjectShortcut } from "@/lib/desktop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const project = await getProject(id);
    if (!project) return json({ error: "Project not found." }, { status: 404 });
    const [runs, files] = await Promise.all([
      listRuns(100),
      listWorkspaceFiles(project.workspacePath, 400).catch(() => []),
    ]);
    return json({ project, runs: runs.filter((run) => run.projectId === id), files });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const project = await getProject(id);
    const removed = await deleteProject(id);
    if (!removed) return json({ error: "Project not found." }, { status: 404 });
    await removeProjectShortcut(project?.desktopLink);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
