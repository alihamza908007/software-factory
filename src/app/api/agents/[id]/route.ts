import { apiError, json } from "@/lib/api";
import { deleteAgent, getAgent, listMetrics, saveAgent } from "@/lib/db";
import type { Agent } from "@/lib/types";
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
    const next: Agent = {
      ...agent,
      ...body,
      id: agent.id,
      handle: body.handle ? agent.handle : agent.handle,
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
