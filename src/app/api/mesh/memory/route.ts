import { apiError, json, readJson } from "@/lib/api";
import {
  appendConstraint,
  clearAgentMemory,
  listAgentMemory,
} from "@/lib/mesh/agent-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const agentId = new URL(request.url).searchParams.get("agentId") ?? undefined;
    return json({ memory: await listAgentMemory(agentId) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson<{
      agentId?: string;
      rule?: string;
      source?: "manual" | "validator" | "error" | "guardrail" | "dead-loop" | "negotiation";
    }>(request);
    if (!body.agentId) throw new Error("agentId is required.");
    if (!body.rule?.trim()) throw new Error("rule is required.");
    const constraint = await appendConstraint({
      agentId: body.agentId,
      rule: body.rule.trim(),
      source: body.source ?? "manual",
    });
    return json({ constraint, memory: await listAgentMemory() });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(request: Request) {
  try {
    const agentId = new URL(request.url).searchParams.get("agentId") ?? undefined;
    await clearAgentMemory(agentId);
    return json({ ok: true, memory: await listAgentMemory() });
  } catch (error) {
    return apiError(error);
  }
}
