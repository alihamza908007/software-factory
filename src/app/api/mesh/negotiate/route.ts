import { apiError, json, readJson } from "@/lib/api";
import { listAgents } from "@/lib/db";
import {
  getNegotiation,
  hydrateNegotiations,
  listNegotiations,
  startNegotiation,
  type NegotiationRequest,
} from "@/lib/mesh/negotiator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET(request: Request) {
  try {
    await hydrateNegotiations();
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      const negotiation = getNegotiation(id);
      if (!negotiation) return json({ error: "Negotiation not found." }, { status: 404 });
      return json({ negotiation });
    }
    return json({ negotiations: listNegotiations() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson<Partial<NegotiationRequest>>(request);
    if (!body.leftAgentId || !body.rightAgentId) {
      throw new Error("Choose two agents to negotiate.");
    }
    if (!body.topic?.trim()) throw new Error("A reconciliation topic is required.");
    const agents = await listAgents();
    const left = agents.find((agent) => agent.id === body.leftAgentId);
    const right = agents.find((agent) => agent.id === body.rightAgentId);
    if (!left || !right) throw new Error("Negotiation agent not found.");
    if (!left.enabled || !right.enabled) throw new Error("Both agents must be enabled.");
    const negotiation = startNegotiation({
      ...body,
      leftAgentId: left.id,
      rightAgentId: right.id,
      topic: body.topic.trim(),
      maxRounds: Math.min(4, Math.max(1, body.maxRounds ?? 3)),
      autoApply: Boolean(body.autoApply),
    });
    return json({ negotiation }, { status: 202 });
  } catch (error) {
    return apiError(error, 400);
  }
}
