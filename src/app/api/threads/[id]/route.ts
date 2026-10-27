import { apiError, json } from "@/lib/api";
import { deleteThread, getThread, updateDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const thread = await getThread(id);
    if (!thread) return json({ error: "Thread not found." }, { status: 404 });
    return json({ thread });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { title?: string; projectId?: string; messageId?: string; content?: string };
    const thread = await updateDb((db) => {
      const found = db.threads.find((item) => item.id === id);
      if (!found) return undefined;
      if (body.messageId && typeof body.content === "string") {
        const message = found.messages.find((item) => item.id === body.messageId);
        if (!message) throw new Error("Message not found.");
        if (message.pending) throw new Error("A streaming message cannot be edited yet.");
        if (body.content.length > 100_000) throw new Error("Edited message is too large.");
        message.content = body.content;
        message.error = false;
      }
      if (body.title?.trim()) found.title = body.title.trim();
      if (body.projectId !== undefined) found.projectId = body.projectId;
      found.updatedAt = Date.now();
      return found;
    });
    if (!thread) return json({ error: "Thread not found." }, { status: 404 });
    return json({ thread });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await deleteThread(id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
