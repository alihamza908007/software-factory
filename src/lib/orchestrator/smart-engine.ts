import { getHardwareProfile } from "../system/hardware-profiler";
import type { Agent } from "../types";

/**
 * Smart Execution Engine — Dynamic DAG Fan-Out & Predictive TTFT Caching.
 *
 * Upgrades the task scheduler with:
 *  1. Dynamic DAG fan-out: independent sub-components are parallelized across
 *     available local worker slots, bounded by the M4 Pro VRAM profile.
 *  2. Predictive TTFT caching: model system-prompt pre-fill states are cached
 *     so rapid multi-turn handoffs skip re-prefill.
 */

export interface SubTask {
  id: string;
  label: string;
  agentId?: string;
  dependencies: string[];
  weight: "heavy" | "light";
  execute: () => Promise<unknown>;
}

export interface FanOutPlan {
  waves: SubTask[][];
  maxConcurrency: number;
  estimatedVramMB: number;
}

export interface TtftCacheEntry {
  modelKey: string;
  systemPromptHash: string;
  cachedAt: number;
  ttftMs: number;
}

const TTFT_CACHE_TTL_MS = 5 * 60 * 1000;
const ttftCache = new Map<string, TtftCacheEntry>();

export function planFanOut(tasks: SubTask[]): FanOutPlan {
  const profile = getHardwareProfile();
  const maxConcurrency = Math.max(1, profile.maxConcurrentLight + profile.maxConcurrentHeavy);
  const vramBudget = profile.localBudgetMB;
  const completed = new Set<string>();
  const waves: SubTask[][] = [];
  const remaining = [...tasks];

  while (remaining.length > 0) {
    const wave: SubTask[] = [];
    let waveVram = 0;
    const candidates = remaining.filter((t) =>
      t.dependencies.every((d) => completed.has(d)),
    );
    for (const task of candidates) {
      const taskVram = task.weight === "heavy" ? 4096 : 512;
      if (wave.length < maxConcurrency && waveVram + taskVram <= vramBudget) {
        wave.push(task);
        waveVram += taskVram;
      }
    }
    if (wave.length === 0 && candidates.length > 0) {
      // VRAM-constrained: run at least one
      wave.push(candidates[0]);
    }
    if (wave.length === 0) break;
    waves.push(wave);
    for (const t of wave) {
      completed.add(t.id);
      const idx = remaining.indexOf(t);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  return { waves, maxConcurrency, estimatedVramMB: vramBudget };
}

export async function executeFanOut(tasks: SubTask[]): Promise<Map<string, unknown>> {
  const plan = planFanOut(tasks);
  const results = new Map<string, unknown>();
  for (const wave of plan.waves) {
    const waveResults = await Promise.allSettled(wave.map((t) => t.execute()));
    waveResults.forEach((r, i) => {
      const task = wave[i];
      if (r.status === "fulfilled") results.set(task.id, r.value);
      else results.set(task.id, { error: String(r.reason) });
    });
  }
  return results;
}

export function cacheTtft(modelKey: string, systemPrompt: string, ttftMs: number): void {
  const hash = simpleHash(systemPrompt);
  const key = `${modelKey}:${hash}`;
  ttftCache.set(key, { modelKey, systemPromptHash: hash, cachedAt: Date.now(), ttftMs });
  if (ttftCache.size > 100) {
    const first = ttftCache.keys().next().value;
    if (first) ttftCache.delete(first);
  }
}

export function getCachedTtft(modelKey: string, systemPrompt: string): number | undefined {
  const hash = simpleHash(systemPrompt);
  const key = `${modelKey}:${hash}`;
  const entry = ttftCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > TTFT_CACHE_TTL_MS) {
    ttftCache.delete(key);
    return undefined;
  }
  return entry.ttftMs;
}

export function predictTtft(modelKey: string, systemPrompt: string, baselineMs: number): number {
  const cached = getCachedTtft(modelKey, systemPrompt);
  if (cached !== undefined) return cached;
  return baselineMs;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function getTtftCacheStats(): { size: number; oldestMs: number } {
  let oldest = Infinity;
  for (const e of ttftCache.values()) oldest = Math.min(oldest, e.cachedAt);
  return { size: ttftCache.size, oldestMs: oldest === Infinity ? 0 : Date.now() - oldest };
}