import { apiError, json } from "@/lib/api";
import { getProject } from "@/lib/db";
import { listWorkspaceFiles, readProjectFile, writeProjectFile } from "@/lib/workspace";

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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const project = await getProject(id);
    if (!project) return json({ error: "Project not found." }, { status: 404 });
    const body = (await request.json()) as { file?: string; content?: string };
    if (!body.file || typeof body.content !== "string") throw new Error("A file path and content are required.");
    if (body.content.length > 1_000_000) throw new Error("Edited artifact exceeds the 1 MB limit.");
    await writeProjectFile(project.workspacePath, body.file, body.content);
    return json({ ok: true, file: body.file });
  } catch (error) {
    return apiError(error, 400);
  }
}
