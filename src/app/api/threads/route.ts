import { apiError, json } from "@/lib/core/api";
import { createThread, getProject, listThreads, projectThreadMessages } from "@/lib/data/db";
import type { ChatThread } from "@/lib/core/types";
import { uid } from "@/lib/core/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const threads = await listThreads();
    return json({
      threads: threads.map((thread) => {
        const projection = projectThreadMessages(thread.messages);
        return {
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messageCount: projection.totalCount,
          directMessageCount: projection.directCount,
          handoffCount: projection.handoffCount,
          lastMessage: thread.messages.at(-1) ?? null,
          lastDirectMessage: projection.direct.at(-1) ?? null,
        };
      }),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { title?: string; projectId?: string };
    const title = body.title?.trim();
    if (title && title.length > 120) {
      throw new Error("A conversation title must be 120 characters or fewer.");
    }
    if (body.projectId) {
      const project = await getProject(body.projectId);
      if (!project) throw new Error("That project no longer exists.");
    }
    const now = Date.now();
    const thread: ChatThread = {
      id: uid("thr"),
      title: title || "New conversation",
      projectId: body.projectId || undefined,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await createThread(thread);
    return json({ thread }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
