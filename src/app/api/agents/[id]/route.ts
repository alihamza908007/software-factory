import { apiError, json } from "@/lib/core/api";
import { deleteAgent, getAgent, listAgents, listMetrics, saveAgent } from "@/lib/data/db";
import type { Agent } from "@/lib/core/types";
import { slugify } from "@/lib/core/utils";
import { assertAgentFields } from "@/lib/data/agent-input";
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
    assertAgentFields(body);
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
      name: body.name !== undefined ? body.name.trim() : agent.name,
      role: body.role !== undefined ? body.role.trim() : agent.role,
      description:
        body.description !== undefined && body.description.trim()
          ? body.description.trim()
          : agent.description,
      capabilities: body.capabilities ?? agent.capabilities,
      skills: body.skills ?? agent.skills,
      systemPrompt:
        body.systemPrompt !== undefined ? body.systemPrompt.trim() : agent.systemPrompt,
      modelKey: body.modelKey !== undefined ? body.modelKey.trim() : agent.modelKey,
      fallbackModelKey:
        body.fallbackModelKey !== undefined
          ? body.fallbackModelKey.trim()
          : agent.fallbackModelKey,
      temperature: body.temperature ?? agent.temperature,
      maxTokens: body.maxTokens ?? agent.maxTokens,
      allowConcurrency: body.allowConcurrency ?? agent.allowConcurrency,
      enabled: body.enabled ?? agent.enabled,
      color: body.color ?? agent.color,
      icon: body.icon ?? agent.icon,
      handle,
      updatedAt: Date.now(),
    };
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
