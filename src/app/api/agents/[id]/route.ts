import { apiError, json } from "@/lib/core/api";
import { deleteAgent, getAgent, listAgents, listMetrics, saveAgent } from "@/lib/data/db";
import type { Agent } from "@/lib/core/types";
import { slugify } from "@/lib/core/utils";
import { clearAgentMemory } from "@/lib/mesh/agent-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const agent = await getAgent(id);
    if (!agent) return json({ error: "Agent not found." }, { status: 404 });
    const metrics = await listMetrics(id, 100);
    return json({ agent, metrics });
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
    const agent = await getAgent(id);
    if (!agent) return json({ error: "Agent not found." }, { status: 404 });
    const body = (await request.json()) as Partial<Agent>;
    const requestedHandle = body.handle?.trim();
    let handle = agent.handle;
    if (requestedHandle && requestedHandle !== agent.handle) {
      const slug = slugify(requestedHandle);
      if (!slug) throw new Error("Agent handle must contain letters or numbers.");
      const others = await listAgents();
      if (others.some((item) => item.id !== agent.id && item.handle === slug)) {
        throw new Error(`Handle @${slug} is already in use.`);
      }
      handle = slug;
    }
    const next: Agent = {
      ...agent,
      ...body,
      id: agent.id,
      handle,
      updatedAt: Date.now(),
    };
    if (body.modelKey) next.modelKey = body.modelKey;
    await saveAgent(next);
    return json({ agent: next });
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
    const removed = await deleteAgent(id);
    if (!removed) return json({ error: "Agent not found." }, { status: 404 });
    await clearAgentMemory(id);
    return json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
