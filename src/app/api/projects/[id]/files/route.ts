import { apiError, json } from "@/lib/api";
import { getProject } from "@/lib/db";
import { listWorkspaceFiles, readProjectFile } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const project = await getProject(id);
    if (!project) return json({ error: "Project not found." }, { status: 404 });
    const url = new URL(request.url);
    const file = url.searchParams.get("file");
    if (file) {
      const content = await readProjectFile(project.workspacePath, file);
      return json({ file, content });
    }
    const files = await listWorkspaceFiles(project.workspacePath, 500);
    return json({ files });
  } catch (error) {
    return apiError(error);
  }
}
