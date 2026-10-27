import { describe, it, expect, beforeEach } from "vitest";
import { handleEvent, ensureAnalyticsRuntime, getAgentAnalytics, recordPostFlightResult, load } from "@/lib/mesh/analytics";
import { meshBus } from "@/lib/mesh/event-bus";
import type { MeshEvent } from "@/lib/types";

describe("analytics dedupe", () => {
  beforeEach(async () => {
    await load();
    ensureAnalyticsRuntime();
  });

  it("does not double-count a TASK_CONTRACT event with the same id", async () => {
    const agentId = "agent-dedupe-1";
    const event: MeshEvent = {
      id: "evt-dedupe-1",
      type: "TASK_CONTRACT",
      source: "x",
      agentId,
      at: Date.now(),
      sequence: 1,
      severity: "info",
      title: "Task accepted",
      message: "ok",
      payload: { contract: { taskId: "task-1", status: "ACCEPTED", targetAgent: "A" } },
    } as any;
    handleEvent(event);
    handleEvent(event); // duplicate id -> skipped
    const stats = await getAgentAnalytics([{ id: agentId, name: "A", handle: "a", role: "dev", enabled: true } as any]);
    expect(stats[0]?.tasksAssigned ?? 0).toBe(1);
  });

  it("recordPostFlightResult increments post-flight counters", async () => {
    const agentId = "agent-pf-1";
    await recordPostFlightResult(agentId, "task-pf-1", true);
    const stats = await getAgentAnalytics([{ id: agentId, name: "A", handle: "a", role: "dev", enabled: true } as any]);
    expect(stats[0]?.postFlightPassed ?? 0).toBeGreaterThanOrEqual(1);
  });
});