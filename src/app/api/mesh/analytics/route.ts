import { apiError, json } from "@/lib/api";
import { listAgents } from "@/lib/db";
import { ensureAnalyticsRuntime, getAgentAnalytics } from "@/lib/mesh/analytics";
import { sharedCache } from "@/lib/mesh/shared-cache";
import { scratchpadStats } from "@/lib/system/storage-cleaner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    ensureAnalyticsRuntime();
    const agents = await getAgentAnalytics(await listAgents());
    const totals = agents.reduce(
      (sum, agent) => ({
        tasksAssigned: sum.tasksAssigned + agent.tasksAssigned,
        accepted: sum.accepted + agent.accepted,
        rejected: sum.rejected + agent.rejected,
        tokensConsumed: sum.tokensConsumed + agent.tokensConsumed,
        postFlightPassed: sum.postFlightPassed + agent.postFlightPassed,
        postFlightFailed: sum.postFlightFailed + agent.postFlightFailed,
        artifactFiles: sum.artifactFiles + agent.artifactFiles,
        artifactBytes: sum.artifactBytes + agent.artifactBytes,
      }),
      {
        tasksAssigned: 0,
        accepted: 0,
        rejected: 0,
        tokensConsumed: 0,
        postFlightPassed: 0,
        postFlightFailed: 0,
        artifactFiles: 0,
        artifactBytes: 0,
      },
    );
    return json({
      generatedAt: Date.now(),
      agents,
      totals,
      cache: sharedCache.stats(),
      scratchpads: scratchpadStats(),
    });
  } catch (error) {
    return apiError(error);
  }
}
