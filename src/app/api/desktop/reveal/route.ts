import path from "node:path";
import { apiError, json, readJson } from "@/lib/core/api";
import { WORKSPACES_ROOT } from "@/lib/data/db";
import { runCommand } from "@/lib/runtime/tools/terminal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reveal a workspace folder in the file manager (macOS `open -R`). */
export async function POST(request: Request) {
  try {
    const body = await readJson<{ path?: string }>(request);
    const target = body.path?.trim();
    if (!target) throw new Error("A workspace path is required.");
    if (process.platform !== "darwin") {
      return json({ ok: false, error: "Reveal is only available on macOS." });
    }
    const root = path.resolve(WORKSPACES_ROOT);
    const resolved = path.resolve(target);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("That path is not a factory workspace.");
    }
    const result = await runCommand("open", ["-R", resolved], {
      cwd: path.dirname(resolved),
      timeoutMs: 5_000,
      allowlist: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to open the workspace folder.");
    }
    return json({ ok: true, path: resolved });
  } catch (error) {
    return apiError(error);
  }
}
