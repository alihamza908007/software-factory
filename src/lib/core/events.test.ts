import { describe, it, expect } from "vitest";
import { runEvents } from "@/lib/core/events";
import type { RunEvent } from "@/lib/core/types";

describe("run event sequencing", () => {
  it("assigns ordered ids and replays only unseen events", () => {
    const runId = `seq-${Date.now()}`;
    const event = (message: string): RunEvent => ({ type: "error", runId, message });
    const seen: number[] = [];
    const unsubscribe = runEvents.subscribe(runId, (_event, sequence) => seen.push(sequence));
    runEvents.publish(runId, event("one"));
    runEvents.publish(runId, event("two"));
    runEvents.publish(runId, event("three"));
    unsubscribe();

    expect(seen).toEqual([1, 2, 3]);
    expect(runEvents.sequenceNumber(runId)).toBe(3);
    expect(runEvents.since(runId, 1).map((item) => item.sequence)).toEqual([2, 3]);
    runEvents.clear(runId);
  });
});
