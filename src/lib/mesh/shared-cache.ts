import { readProjectFile } from "../workspace";

export interface SharedCacheOptions {
  /** Scope the entry to a single run/session. Omit for mesh-wide sharing. */
  runId?: string;
  /** Agent that produced the entry, retained for observability. */
  agentId?: string;
  /** Time-to-live in milliseconds. Defaults to the current run session window. */
  ttlMs?: number;
}

export interface SharedCacheEntry<T = unknown> {
  key: string;
  value: T;
  runId?: string;
  agentId?: string;
  storedAt: number;
  expiresAt?: number;
  hits: number;
}

export interface SharedCacheStats {
  entries: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  bytes: number;
}

interface CacheState {
  entries: Map<string, SharedCacheEntry>;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

interface CacheGlobal {
  __factorySharedCache?: CacheState;
}

const globalStore = globalThis as typeof globalThis & CacheGlobal;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 512;

function state(): CacheState {
  return (globalStore.__factorySharedCache ??= {
    entries: new Map<string, SharedCacheEntry>(),
    hits: 0,
    misses: 0,
    writes: 0,
    evictions: 0,
  });
}

function scopedKey(key: string, runId?: string): string {
  const normalized = key.trim();
  return runId ? `${runId}::${normalized}` : normalized;
}

function approxBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function sweep(now = Date.now()): void {
  const store = state();
  for (const [key, entry] of store.entries) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      store.entries.delete(key);
      store.evictions += 1;
    }
  }
}

/**
 * Fast, in-process key/value state shared by every active agent in a mesh run.
 * Agents write parsed metadata once (schema, package manifest, route map) and
 * peers read it without spending another LLM call or touching disk again.
 */
class SharedCache {
  set<T>(key: string, data: T, options: SharedCacheOptions = {}): T {
    const store = state();
    sweep();
    const normalized = key.trim();
    if (!normalized) throw new Error("SharedCache keys must be non-empty.");
    const scoped = scopedKey(normalized, options.runId);
    const ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_TTL_MS);
    const entry: SharedCacheEntry<T> = {
      key: scoped,
      value: data,
      runId: options.runId,
      agentId: options.agentId,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      hits: 0,
    };
    store.entries.set(scoped, entry as SharedCacheEntry);
    store.writes += 1;
    while (store.entries.size > MAX_ENTRIES) {
      const oldest = Array.from(store.entries.values()).sort((a, b) => a.storedAt - b.storedAt)[0];
      if (!oldest) break;
      store.entries.delete(oldest.key);
      store.evictions += 1;
    }
    return data;
  }

  get<T>(key: string, options: { runId?: string } = {}): T | undefined {
    const store = state();
    const scoped = scopedKey(key, options.runId);
    const entry = store.entries.get(scoped);
    if (!entry) {
      store.misses += 1;
      return undefined;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      store.entries.delete(scoped);
      store.evictions += 1;
      store.misses += 1;
      return undefined;
    }
    entry.hits += 1;
    store.hits += 1;
    return entry.value as T;
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T> | T,
    options: SharedCacheOptions = {},
  ): Promise<T> {
    const cached = this.get<T>(key, { runId: options.runId });
    if (cached !== undefined) return cached;
    const loaded = await loader();
    if (loaded !== undefined) this.set(key, loaded, options);
    return loaded;
  }

  has(key: string, options: { runId?: string } = {}): boolean {
    return this.get(key, options) !== undefined;
  }

  delete(key: string, options: { runId?: string } = {}): boolean {
    return state().entries.delete(scopedKey(key, options.runId));
  }

  clear(runId?: string): void {
    const store = state();
    if (!runId) {
      store.entries.clear();
      return;
    }
    const prefix = `${runId}::`;
    for (const key of store.entries.keys()) {
      if (key.startsWith(prefix)) store.entries.delete(key);
    }
  }

  keys(runId?: string): string[] {
    sweep();
    const prefix = runId ? `${runId}::` : undefined;
    return Array.from(state().entries.keys())
      .filter((key) => !prefix || key.startsWith(prefix))
      .sort();
  }

  stats(): SharedCacheStats {
    sweep();
    const entries = Array.from(state().entries.values());
    return {
      entries: entries.length,
      hits: state().hits,
      misses: state().misses,
      writes: state().writes,
      evictions: state().evictions,
      bytes: entries.reduce((sum, entry) => sum + approxBytes(entry.value), 0),
    };
  }

  snapshot(): Array<Omit<SharedCacheEntry, "value"> & { bytes: number }> {
    sweep();
    return Array.from(state().entries.values())
      .sort((a, b) => b.storedAt - a.storedAt)
      .map((entry) => ({
        key: entry.key,
        runId: entry.runId,
        agentId: entry.agentId,
        storedAt: entry.storedAt,
        expiresAt: entry.expiresAt,
        hits: entry.hits,
        bytes: approxBytes(entry.value),
      }));
  }
}

export const sharedCache = new SharedCache();

export function sharedCacheKey(...parts: Array<string | number | undefined>): string {
  return parts
    .filter((part): part is string | number => part !== undefined && part !== null && `${part}`.trim() !== "")
    .map((part) => String(part).replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .join(":");
}

/** Read a workspace file once and keep its contents available to peer agents. */
export async function readCachedWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  options: SharedCacheOptions = {},
): Promise<string> {
  const key = sharedCacheKey("workspace", workspaceRoot, "file", relativePath);
  return sharedCache.getOrLoad(key, () => readProjectFile(workspaceRoot, relativePath), options);
}

/** Cache parsed JSON metadata (schema maps, package manifests, route tables). */
export function setCachedWorkspaceMetadata<T>(
  workspaceRoot: string,
  kind: string,
  relativePath: string,
  data: T,
  options: SharedCacheOptions = {},
): T {
  return sharedCache.set(sharedCacheKey("workspace", workspaceRoot, kind, relativePath), data, options);
}

export function getCachedWorkspaceMetadata<T>(
  workspaceRoot: string,
  kind: string,
  relativePath: string,
  options: { runId?: string } = {},
): T | undefined {
  return sharedCache.get<T>(sharedCacheKey("workspace", workspaceRoot, kind, relativePath), options);
}
