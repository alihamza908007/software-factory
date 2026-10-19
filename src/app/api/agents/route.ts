import { apiError, json } from "@/lib/api";
import { listAgents, listMetrics, saveAgent } from "@/lib/db";
import type { Agent } from "@/lib/types";
import { AGENT_PALETTE } from "@/lib/constants";
import { slugify, uid } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [agents, metrics] = await Promise.all([listAgents(), listMetrics(undefined, 300)]);
    return json({ agents, metrics });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<Agent>;
    if (!body.name?.trim()) throw new Error("Agent name is required.");
    if (!body.role?.trim()) throw new Error("Agent role is required.");
    if (!body.modelKey?.trim()) throw new Error("A model must be assigned.");
    const existing = await listAgents();
    let handle = slugify(body.handle || body.name) || "agent";
    if (existing.some((agent) => agent.handle === handle)) {
      handle = `${handle}-${Math.random().toString(36).slice(2, 5)}`;
    }
    const now = Date.now();
    const agent: Agent = {
      id: uid("agent"),
      name: body.name.trim(),
      handle,
      role: body.role.trim(),
      description: body.description?.trim() || `${body.role} agent`,
      systemPrompt:
        body.systemPrompt?.trim() ||
        `You are ${body.name}, the ${body.role} in an autonomous software factory. Be precise, evidence-driven and concise.`,
      modelKey: body.modelKey,
      fallbackModelKey: body.fallbackModelKey,
      temperature: body.temperature ?? 0.3,
      maxTokens: body.maxTokens ?? 4096,
      allowConcurrency: body.allowConcurrency ?? true,
      enabled: body.enabled ?? true,
      color: body.color || AGENT_PALETTE[existing.length % AGENT_PALETTE.length],
      icon: body.icon || "Bot",
      createdAt: now,
      updatedAt: now,
    };
    await saveAgent(agent);
    return json({ agent }, { status: 201 });
  } catch (error) {
    return apiError(error, 400);
  }
}
