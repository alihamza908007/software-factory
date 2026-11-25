import { describe, it, expect } from "vitest";
import { chatEvents } from "@/lib/data/chat-events";

describe("chat event bus", () => {
  it("publishes ordered sequences and replays unseen events", () => {
    const threadId = `chat-test-${Date.now()}`;
    const seen: number[] = [];
    const unsubscribe = chatEvents.subscribe(threadId, (_event, sequence) => seen.push(sequence));
    chatEvents.publish(threadId, { type: "message", content: "hi" });
    chatEvents.publish(threadId, { type: "token", text: "yo" });
    unsubscribe();

    expect(seen).toEqual([1, 2]);
    expect(chatEvents.sequenceNumber(threadId)).toBe(2);
    expect(chatEvents.since(threadId, 1).map((item) => item.sequence)).toEqual([2]);
    expect(chatEvents.backlog(threadId)).toHaveLength(2);

    chatEvents.clear(threadId);
    expect(chatEvents.backlog(threadId)).toHaveLength(0);
  });
});
