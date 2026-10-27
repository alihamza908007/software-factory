import type { Agent } from "../types";
import { agentCapabilities, routeTask } from "./accountability";
import { publishMeshEvent } from "./event-bus";

export interface AgentRosterEntry {
  handle: `@${string}`;
  id: string;
  name: string;
  role: string;
  capabilities: string[];
}

export function buildAgentRoster(agents: Agent[]): AgentRosterEntry[] {
  return agents.filter((agent) => agent.enabled).map((agent) => ({
    handle: `@${agent.handle.replace(/^@/, "")}`,
    id: agent.id,
    name: agent.name,
    role: agent.role,
    capabilities: agentCapabilities(agent),
  }));
}

export function agentRosterPrompt(agents: Agent[]): string {
  return [
    "LIVE ACTIVE AGENT ROSTER (authoritative; only these exact handles can receive work):",
    JSON.stringify(buildAgentRoster(agents), null, 2),
    "STRICT BEHAVIORAL GUARDRAILS (non-negotiable):",
    "1. ZERO HALLUCINATION OF HANDLES — never invent, mutate, or infer an @handle. Address peers only with an exact handle present in the live roster above. If nobody fits, state the capability gap without naming a recipient.",
    "2. NO SCOPE CREEP — execute only the assigned objective in the TaskContract. If you discover an out-of-scope bug or improvement, emit one separate line `SCOPE_ADVISORY: <one-sentence finding>` and return to the assigned objective; never expand the current implementation to fix it.",
    "3. ACTIONABLE COMMUNICATION — every message must do at least one of: ask a clarifying question with concrete options, report a verified metric/runtime fact, or deliver a pointer-based artifact handoff with file paths. No greetings, conversational filler, or unverifiable status prose.",
    "COMMUNICATION PROTOCOLS: Resolution-first: never report BLOCKED or FAILED without an exact resolutionPath containing a concrete file fix or approved command; include that path in the message envelope. State-sync: use only the supplied workspaceRoot and fileTree snapshot for file existence and route ownership. Dependency handshake: before accepting implementation/build work, check duplicate app/page and app/route extensions, package.json, Prisma schema when Prisma is used, and a secret-free .env.example; report conflicts with a resolutionPath and do not proceed to build until they are resolved.",
  ].join("\n");
}

export function resolveAgentHandles(agents: Agent[], handles: string[], objective: string) {
  const active = agents.filter((agent) => agent.enabled);
  const resolved: Agent[] = [];
  const unknown: string[] = [];
  for (const raw of handles) {
    const handle = raw.replace(/^@/, "").toLowerCase();
    const agent = active.find((candidate) => candidate.handle.replace(/^@/, "").toLowerCase() === handle);
    if (agent && !resolved.some((item) => item.id === agent.id)) resolved.push(agent);
    else if (!agent && !unknown.includes(handle)) unknown.push(handle);
  }
  const fallback = unknown.length ? routeTask(active, `${objective}\n${unknown.join(" ")}`).agent : undefined;
  if (unknown.length) {
    publishMeshEvent({
      type: "ROUTING_ERROR",
      source: "Chat router",
      target: unknown.map((handle) => `@${handle}`).join(", "),
      severity: "warning",
      title: "Unknown agent handle intercepted",
      message: `Unknown handle${unknown.length === 1 ? "" : "s"}: ${unknown.map((handle) => `@${handle}`).join(", ")}. ${fallback ? `Routed by capability to ${fallback.name}.` : "No capability match; using the configured default agent."}`,
      payload: { unknownHandles: unknown, fallbackAgentId: fallback?.id },
    });
    if (fallback && !resolved.some((item) => item.id === fallback.id)) resolved.push(fallback);
  }
  return { agents: resolved, unknown, fallback };
}
