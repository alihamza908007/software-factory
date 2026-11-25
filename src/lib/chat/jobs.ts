import { getThread } from "@/lib/data/db";
import type { ChatThread } from "@/lib/core/types";

/**
 * Per-thread registry of chat turn jobs. A job is "running" while the turn
 * engine is executing and flips to "done" when it settles (passed, failed or
 * cancelled). Jobs let a client later wake a turn that is still running on the
 * server, e.g. after a reload, and lets anything list the state.
 */

export interface ChatJobState {
  threadId: string;
  controller: AbortController;
  startedAt: number;
  status: "running" | "done";
}

const globalStore = globalThis as typeof globalThis & {
  __factoryChatJobs?: Map<string, ChatJobState>;
};

export const chatJobs = (globalStore.__factoryChatJobs ??= new Map<string, ChatJobState>());

export function getChatJob(threadId: string): ChatJobState | undefined {
  return chatJobs.get(threadId);
}

export function isChatJobActive(threadId: string): boolean {
  return chatJobs.get(threadId)?.status === "running";
}

export function listChatJobs(threadIds: string[]): ChatJobState[] {
  return threadIds
    .map((id) => chatJobs.get(id))
    .filter((job): job is ChatJobState => Boolean(job));
}

export function cancelChatJob(threadId: string): boolean {
  const job = chatJobs.get(threadId);
  if (!job || job.status !== "running") return false;
  job.controller.abort();
  return true;
}

export function markChatJobDone(threadId: string): void {
  const job = chatJobs.get(threadId);
  if (job && job.status === "running") {
    job.status = "done";
  }
}

export async function threadExists(threadId: string): Promise<boolean> {
  const thread = await getThread(threadId);
  return Boolean(thread as ChatThread | undefined);
}
