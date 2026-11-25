import type { Agent, ModelInfo } from "@/lib/core/types";

export interface ModelReconcileUpdate {
  agent: Agent;
  modelKey: string;
}

export interface ModelReconcilePlan {
  updates: ModelReconcileUpdate[];
  unresolved: Agent[];
}

const BUILD_ROLES = /developer|engineer|architect|full.?stack|programmer/i;
const NON_BUILD_ROLES = /qa|test|quality|security|audit|docs|writer|dependenc|accessib/i;

function prefersLocalModel(agent: Agent): boolean {
  if (NON_BUILD_ROLES.test(agent.role)) return false;
  return BUILD_ROLES.test(agent.role);
}

function firstKnown(
  keys: Array<string | undefined>,
  known: Set<string>,
): string | undefined {
  for (const key of keys) {
    if (key && known.has(key)) return key;
  }
  return undefined;
}

/**
 * Map agents whose assigned model is not in the current catalogue onto a model
 * that is. A model may disappear when a local tag is deleted, an LM Studio
 * model is unloaded, or an OpenCode model is retired.
 *
 * Order of preference: the agent's own fallback, then (for build roles) a
 * local heavy/light model, then cloud, then anything online. Agents are never
 * left on a key the catalogue cannot resolve.
 */
export function planModelReconciliation(
  agents: Agent[],
  models: ModelInfo[],
): ModelReconcilePlan {
  const known = new Set(models.map((model) => model.key));
  const pool = models.filter((model) => model.online);
  const usable = pool.length ? pool : models;
  const cloud = usable.find((model) => model.kind === "cloud");
  const localHeavy = usable.find((model) => model.kind === "local" && model.heavy);
  const localLight = usable.find((model) => model.kind === "local" && !model.heavy);
  const anyLocal = usable.find((model) => model.kind === "local");

  const updates: ModelReconcileUpdate[] = [];
  const unresolved: Agent[] = [];

  for (const agent of agents) {
    if (known.has(agent.modelKey)) continue;
    const builds = prefersLocalModel(agent);
    const next = firstKnown(
      [
        agent.fallbackModelKey,
        builds ? localHeavy?.key : undefined,
        builds ? anyLocal?.key : undefined,
        cloud?.key,
        localLight?.key,
        usable[0]?.key,
      ],
      known,
    );
    if (next) updates.push({ agent, modelKey: next });
    else unresolved.push(agent);
  }

  return { updates, unresolved };
}
