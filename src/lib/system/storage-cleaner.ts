import { promises as fs } from "node:fs";
import path from "node:path";
import type { MeshEvent } from "../types";
import { appendHandoffMemory } from "../mesh/agent-memory";
import { meshBus } from "../mesh/event-bus";

export interface StorageCleanupResult {
  workspaceRoot: string;
  removed: string[];
  skipped: string[];
  bytes: number;
  errors: string[];
  cleanedAt: number;
}

export interface ScratchpadEntry {
  agentId: string;
  taskId: string;
  key: string;
  content: string;
  createdAt: number;
  expiresAt: number;
}

export interface CompleteTaskStorageInput {
  agentId: string;
  taskId: string;
  summary: string;
  modifiedFiles: string[];
  workspaceRoot?: string;
}

export interface CompleteTaskStorageResult {
  droppedScratchpadEntries: number;
  cleanup?: StorageCleanupResult;
  memoryAppended: boolean;
}

interface StorageGlobal {
  __factoryAgentScratchpads?: Map<string, Map<string, ScratchpadEntry>>;
  __factoryStorageLifecycle?: boolean;
  __factoryStorageTimer?: ReturnType<typeof setInterval>;
  __factoryStorageSeen?: Set<string>;
}

type Entry = ScratchpadEntry;
const globalStore = globalThis as typeof globalThis & StorageGlobal;

const DEFAULT_SCRATCHPAD_TTL_MS = 30 * 60 * 1000;
const MAX_SCRATCHPAD_ENTRIES = 96;
const MAX_SCRATCHPAD_CHARS = 160_000;
const SWEEP_INTERVAL_MS = 60_000;

/** Directories that are execution output, never authoritative project source. */
const TRANSIENT_DIRECTORIES = new Set([
  ".tmp",
  "tmp",
  ".factory-tmp",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".next",
  "dist",
  "build",
  "coverage",
  ".nyc_output",
  ".vercel",
]);

const TRANSIENT_FILE_PATTERNS: RegExp[] = [
  /^npm-debug\.log(?:\.\d+)?$/i,
  /^yarn-(?:error|debug)\.log$/i,
  /^pnpm-debug\.log$/i,
  /^\.eslintcache$/i,
  /\.(?:tmp|temp|dump)$/i,
  /\.tsbuildinfo$/i,
  /^(?:verification|runtime|build|test)[-_].*\.log$/i,
  /^(?:stdout|stderr)\.log$/i,
];

const PROTECTED_TOP_LEVEL = new Set([
  "src",
  "app",
  "pages",
  "components",
  "lib",
  "prisma",
  "public",
  "tests",
  "test",
  "docs",
  "scripts",
  "data",
  ".data",
  ".git",
  "node_modules",
  "factory.json",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
]);

function scratchpads(): Map<string, Map<string, Entry>> {
  return (globalStore.__factoryAgentScratchpads ??= new Map<string, Map<string, Entry>>());
}

function scratchpadKey(taskId: string, key: string): string {
  return `${taskId}::${key}`;
}

function isInside(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved !== rootResolved && resolved.startsWith(`${rootResolved}${path.sep}`);
}

async function sizeOf(target: string): Promise<number> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(target, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await sizeOf(path.join(target, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function looksLikeSourceDirectory(entries: string[]): boolean {
  const protectedChildren = new Set(["src", "app", "lib", "components", "prisma", "package.json", "tsconfig.json"]);
  return entries.some((entry) => protectedChildren.has(entry));
}

/**
 * Purge transient execution output from a managed workspace. The allowlist is
 * deliberately narrow: source directories, package manifests, .data and the
 * database are never candidates for deletion.
 */
export async function purgeWorkspaceTransients(workspaceRoot: string): Promise<StorageCleanupResult> {
  const result: StorageCleanupResult = {
    workspaceRoot,
    removed: [],
    skipped: [],
    bytes: 0,
    errors: [],
    cleanedAt: Date.now(),
  };
  let rootStat;
  try {
    rootStat = await fs.lstat(workspaceRoot);
  } catch {
    return result;
  }
  if (!rootStat.isDirectory()) return result;

  let entries;
  try {
    entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    result.errors.push(`Could not read workspace: ${String(error)}`);
    return result;
  }

  for (const entry of entries) {
    if (PROTECTED_TOP_LEVEL.has(entry.name)) {
      if (TRANSIENT_DIRECTORIES.has(entry.name)) result.skipped.push(entry.name);
      continue;
    }
    const absolute = path.join(workspaceRoot, entry.name);
    if (!isInside(workspaceRoot, absolute)) {
      result.skipped.push(entry.name);
      continue;
    }

    if (entry.isDirectory() && TRANSIENT_DIRECTORIES.has(entry.name)) {
      try {
        const children = await fs.readdir(absolute).catch(() => []);
        if (looksLikeSourceDirectory(children)) {
          result.skipped.push(entry.name);
          continue;
        }
        const bytes = await sizeOf(absolute);
        await fs.rm(absolute, { recursive: true, force: true });
        result.bytes += bytes;
        result.removed.push(entry.name);
      } catch (error) {
        result.errors.push(`${entry.name}: ${String(error)}`);
      }
      continue;
    }

    if (entry.isFile() && TRANSIENT_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      try {
        const bytes = await sizeOf(absolute);
        await fs.rm(absolute, { force: true });
        result.bytes += bytes;
        result.removed.push(entry.name);
      } catch (error) {
        result.errors.push(`${entry.name}: ${String(error)}`);
      }
    }
  }

  // Verification logs are sometimes nested under a conventional logs directory.
  const logsDir = path.join(workspaceRoot, "logs");
  const logEntries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of logEntries) {
    if (!entry.isFile() || !/^(?:verification|runtime|build|test)[-_].*\.log$/i.test(entry.name)) continue;
    const absolute = path.join(logsDir, entry.name);
    try {
      const bytes = await sizeOf(absolute);
      await fs.rm(absolute, { force: true });
      result.bytes += bytes;
      result.removed.push(path.join("logs", entry.name));
    } catch (error) {
      result.errors.push(`logs/${entry.name}: ${String(error)}`);
    }
  }

  return result;
}

export function putScratchpadContent(input: {
  agentId: string;
  taskId: string;
  key: string;
  content: string;
  ttlMs?: number;
}): ScratchpadEntry {
  sweepExpiredScratchpads();
  const now = Date.now();
  const entry: ScratchpadEntry = {
    agentId: input.agentId,
    taskId: input.taskId,
    key: input.key,
    content: input.content.slice(0, MAX_SCRATCHPAD_CHARS),
    createdAt: now,
    expiresAt: now + Math.max(5_000, input.ttlMs ?? DEFAULT_SCRATCHPAD_TTL_MS),
  };
  const byAgent = scratchpads().get(input.agentId) ?? new Map<string, Entry>();
  byAgent.set(scratchpadKey(input.taskId, input.key), entry);
  while (byAgent.size > MAX_SCRATCHPAD_ENTRIES) {
    const oldest = Array.from(byAgent.values()).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    byAgent.delete(scratchpadKey(oldest.taskId, oldest.key));
  }
  scratchpads().set(input.agentId, byAgent);
  return entry;
}

export function getScratchpadContent(
  agentId: string,
  taskId: string,
  key: string,
): string | undefined {
  sweepExpiredScratchpads();
  return scratchpads().get(agentId)?.get(scratchpadKey(taskId, key))?.content;
}

export function dropTaskScratchpad(agentId: string, taskId: string): number {
  const byAgent = scratchpads().get(agentId);
  if (!byAgent) return 0;
  let dropped = 0;
  for (const [key, entry] of byAgent) {
    if (entry.taskId !== taskId) continue;
    byAgent.delete(key);
    dropped += 1;
  }
  if (!byAgent.size) scratchpads().delete(agentId);
  return dropped;
}

export function sweepExpiredScratchpads(now = Date.now()): number {
  let removed = 0;
  for (const [agentId, byAgent] of scratchpads()) {
    for (const [key, entry] of byAgent) {
      if (entry.expiresAt > now) continue;
      byAgent.delete(key);
      removed += 1;
    }
    if (!byAgent.size) scratchpads().delete(agentId);
  }
  return removed;
}

export function scratchpadStats(): { agents: number; entries: number; bytes: number } {
  sweepExpiredScratchpads();
  let entries = 0;
  let bytes = 0;
  for (const byAgent of scratchpads().values()) {
    entries += byAgent.size;
    for (const entry of byAgent.values()) bytes += Buffer.byteLength(entry.content, "utf8");
  }
  return { agents: scratchpads().size, entries, bytes };
}

/**
 * Complete a task's storage lifecycle: drop every raw scratchpad entry, retain
 * only the semantic summary plus file pointers in long-term memory, then purge
 * transient workspace output. Safe to call repeatedly.
 */
export async function completeTaskStorage(
  input: CompleteTaskStorageInput,
): Promise<CompleteTaskStorageResult> {
  const droppedScratchpadEntries = dropTaskScratchpad(input.agentId, input.taskId);
  let memoryAppended = false;
  try {
    await appendHandoffMemory({
      agentId: input.agentId,
      taskId: input.taskId,
      summary: input.summary,
      modifiedFiles: input.modifiedFiles,
    });
    memoryAppended = true;
  } catch {
    // Memory is useful but must never block a successful handoff.
  }
  const cleanup = input.workspaceRoot
    ? await purgeWorkspaceTransients(input.workspaceRoot)
    : undefined;
  ensureStorageLifecycle();
  return { droppedScratchpadEntries, cleanup, memoryAppended };
}

function rememberEvent(event: MeshEvent): boolean {
  const seen = (globalStore.__factoryStorageSeen ??= new Set<string>());
  if (seen.has(event.id)) return false;
  seen.add(event.id);
  if (seen.size > 600) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  return true;
}

/**
 * Subscribe the storage manager to POST_FLIGHT_PASSED and run a TTL sweep for
 * scratchpads. The direct completion call in verifyPostFlight is the primary
 * path; this subscription covers externally published pass events.
 */
export function ensureStorageLifecycle(): void {
  if (globalStore.__factoryStorageLifecycle) return;
  globalStore.__factoryStorageLifecycle = true;

  globalStore.__factoryStorageTimer ??= setInterval(() => {
    sweepExpiredScratchpads();
  }, SWEEP_INTERVAL_MS);
  globalStore.__factoryStorageTimer.unref?.();

  meshBus.subscribe("POST_FLIGHT_PASSED", async (event) => {
    if (!rememberEvent(event)) return;
    if (event.payload?.storageCleanup) return;
    const workspaceRoot = typeof event.payload?.workspaceRoot === "string" ? event.payload.workspaceRoot : undefined;
    if (!workspaceRoot) return;
    await purgeWorkspaceTransients(workspaceRoot);
  });
}
