import { promises as fs } from "node:fs";
import path from "node:path";
import type { CommandResult } from "@/lib/core/types";
import { listWorkspaceFiles } from "@/lib/data/workspace";

type CachedVerification = {
  fingerprint: string;
  results: CommandResult[];
  failed: boolean;
  at: number;
};

const MAX_ENTRIES = 40;
const MAX_AGE_MS = 15 * 60 * 1000;
const caches = new Map<string, CachedVerification>();

/**
 * A cheap content fingerprint of the managed source tree. node_modules and other
 * ignored directories are excluded by listWorkspaceFiles, so dependency installs
 * do not invalidate an otherwise unchanged verification result.
 */
export async function workspaceFingerprint(root: string): Promise<string> {
  const files = await listWorkspaceFiles(root, 500);
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(path.join(root, file));
      parts.push(`${file}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      // The file may have been replaced between listing and stat; ignore it.
    }
  }
  return parts.join("|");
}

export function getCachedVerification(runId: string, fingerprint: string): CachedVerification | undefined {
  const cached = caches.get(runId);
  if (!cached || cached.fingerprint !== fingerprint) return undefined;
  if (Date.now() - cached.at > MAX_AGE_MS) {
    caches.delete(runId);
    return undefined;
  }
  return cached;
}

export function setCachedVerification(
  runId: string,
  fingerprint: string,
  results: CommandResult[],
  failed: boolean,
): void {
  caches.set(runId, { fingerprint, results, failed, at: Date.now() });
  if (caches.size > MAX_ENTRIES) {
    const oldest = Array.from(caches.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) caches.delete(oldest[0]);
  }
}

export function clearVerificationCache(runId: string): void {
  caches.delete(runId);
}
