import { apiError, json } from "@/lib/core/api";
import { listAgents, saveAgent } from "@/lib/data/db";
import { listModels } from "@/lib/providers/catalog";
import { planModelReconciliation } from "@/lib/providers/model-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reassign agents whose configured model is missing from the live catalogue.
 * Called explicitly from the Agents surface (never on a read) so a user can see
 * and confirm what changed.
 */
export async function POST() {
  try {
    const [{ models }, agents] = await Promise.all([listModels(true), listAgents()]);
    const { updates, unresolved } = planModelReconciliation(agents, models);
    const now = Date.now();
    for (const { agent, modelKey } of updates) {
      await saveAgent({ ...agent, modelKey, updatedAt: now });
    }
    return json({
      updated: updates.map(({ agent, modelKey }) => ({
        id: agent.id,
        name: agent.name,
        from: agent.modelKey,
        to: modelKey,
      })),
      unresolved: unresolved.map((agent) => ({ id: agent.id, name: agent.name })),
    });
  } catch (error) {
    return apiError(error);
  }
}
