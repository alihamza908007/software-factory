import { describe, it, expect } from "vitest";
import { cancelChatJob, chatJobs, getChatJob, isChatJobActive, markChatJobDone } from "@/lib/chat/jobs";

describe("chat job registry", () => {
  it("starts inactive and allows cancelling while running", () => {
    const threadId = `jobs-${Date.now()}`;
    expect(isChatJobActive(threadId)).toBe(false);
    const job = {
      threadId,
      controller: new AbortController(),
      startedAt: Date.now(),
      status: "running" as const,
    };
    chatJobs.set(threadId, job);
    try {
      expect(isChatJobActive(threadId)).toBe(true);
      expect(cancelChatJob(threadId)).toBe(true);
      expect(job.controller.signal.aborted).toBe(true);
      expect(cancelChatJob(threadId)).toBe(true); // still running until settled
      markChatJobDone(threadId);
      expect(isChatJobActive(threadId)).toBe(false);
      expect(getChatJob(threadId)?.status).toBe("done");
    } finally {
      chatJobs.delete(threadId);
    }
  });

  it("cancel on a settled job is a no-op", () => {
    const threadId = `jobs-${Date.now()}`;
    const job = {
      threadId,
      controller: new AbortController(),
      startedAt: Date.now(),
      status: "done" as const,
    };
    chatJobs.set(threadId, job);
    try {
      expect(cancelChatJob(threadId)).toBe(false);
      expect(job.controller.signal.aborted).toBe(false);
    } finally {
      chatJobs.delete(threadId);
    }
  });
});
