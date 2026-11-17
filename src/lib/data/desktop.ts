import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Projects live canonically in `.data/workspaces`. To make them easy to find,
 * each new project gets a symlink in `~/Desktop/Software Factory` that points
 * at its workspace. The shortcut is a convenience only: deleting it never
 * deletes the project.
 */

export function desktopRoot(): string {
  return path.join(os.homedir(), "Desktop", "Software Factory");
}

function sanitizeName(name: string): string {
  return name
    .replace(/[/\\:]/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function pointsAt(linkPath: string, workspacePath: string): Promise<boolean> {
  try {
    const target = await fs.readlink(linkPath);
    const resolved = path.resolve(path.dirname(linkPath), target);
    return resolved === path.resolve(workspacePath);
  } catch {
    return false;
  }
}

export interface DesktopShortcutResult {
  path?: string;
  error?: string;
}

export async function createProjectShortcut(
  name: string,
  workspacePath: string,
  projectId: string,
): Promise<DesktopShortcutResult> {
  const desktop = path.join(os.homedir(), "Desktop");
  try {
    await fs.access(desktop);
  } catch {
    return { error: `Desktop folder not found at ${desktop}.` };
  }

  const root = desktopRoot();
  try {
    await fs.mkdir(root, { recursive: true });
  } catch (error) {
    return { error: `Could not create ${root}: ${String(error)}` };
  }

  const base = sanitizeName(name) || "Project";
  const suffix = projectId.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
  let candidate = path.join(root, base);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() && (await pointsAt(candidate, workspacePath))) {
        return { path: candidate };
      }
      // Never overwrite a user's Desktop item; pick the next free name.
      const label = attempt === 0 ? `${base} (${suffix})` : `${base} (${suffix}-${attempt + 1})`;
      candidate = path.join(root, label);
      continue;
    } catch {
      try {
        await fs.symlink(workspacePath, candidate, "dir");
        return { path: candidate };
      } catch (error) {
        return { error: `Could not create desktop shortcut: ${String(error)}` };
      }
    }
  }

  return { error: "Could not find a free shortcut name on the Desktop." };
}

/** Remove only symlinks created inside the factory's Desktop folder. */
export async function removeProjectShortcut(linkPath?: string): Promise<void> {
  if (!linkPath) return;
  const root = path.resolve(desktopRoot());
  const resolved = path.resolve(linkPath);
  if (!resolved.startsWith(`${root}${path.sep}`)) return;
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) await fs.unlink(resolved);
  } catch {
    // Already gone or unreadable — nothing to clean up.
  }
}
