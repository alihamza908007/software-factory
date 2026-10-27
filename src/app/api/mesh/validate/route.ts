import { apiError, json, readJson } from "@/lib/api";
import { getProject } from "@/lib/db";
import { ensureValidatorRuntime, validateArtifacts, type ValidationArtifact } from "@/lib/mesh/validators";
import { listWorkspaceFiles, readProjectFile } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface ValidateBody {
  projectId?: string;
  agentId?: string;
  threadId?: string;
  runId?: string;
  path?: string;
  content?: string;
  files?: ValidationArtifact[];
  scanWorkspace?: boolean;
}

export async function POST(request: Request) {
  try {
    ensureValidatorRuntime();
    const body = await readJson<ValidateBody>(request);
    let artifacts = (body.files ?? []).filter(
      (file) => typeof file.path === "string" && typeof file.content === "string",
    );
    if (body.path && body.content) {
      artifacts = [{ path: body.path, content: body.content }];
    }
    if (!artifacts.length && body.projectId && body.scanWorkspace !== false) {
      const project = await getProject(body.projectId);
      if (!project) throw new Error("Project not found.");
      const files = await listWorkspaceFiles(project.workspacePath, 40);
      for (const file of files) {
        if (!/\.(js|mjs|cjs|ts|tsx|jsx|py|json|ya?ml)$/.test(file)) continue;
        if (/package-lock|pnpm-lock|yarn.lock/.test(file)) continue;
        try {
          const content = await readProjectFile(project.workspacePath, file);
          artifacts.push({ path: file, content: content.slice(0, 24_000) });
        } catch {
          // Skip unreadable or generated binary files.
        }
        if (artifacts.length >= 24) break;
      }
    }
    if (!artifacts.length) throw new Error("No artifacts were supplied for validation.");
    const report = await validateArtifacts(artifacts, {
      agentId: body.agentId,
      threadId: body.threadId,
      projectId: body.projectId,
      runId: body.runId,
      reason: "Manual operator scan",
    });
    return json({ report });
  } catch (error) {
    return apiError(error, 400);
  }
}
