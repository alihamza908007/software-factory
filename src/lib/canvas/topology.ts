import type { Agent, CanvasNodeData, CanvasTopology } from "../types";

/**
 * Pure canvas helpers. This module must stay free of Node-only imports because
 * the React Flow editor imports it in the browser.
 */
export function validateCanvasTopology(topology: CanvasTopology): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeCount: number;
  edgeCount: number;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodes = topology.nodes ?? [];
  const edges = topology.edges ?? [];
  const ids = new Set<string>();

  for (const node of nodes) {
    if (!node.id) errors.push("A node is missing its id.");
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}.`);
    ids.add(node.id);
    if (node.type === "agent" && !node.data.agentId) {
      warnings.push(`${node.data.label || node.id} has no agent assigned.`);
    }
    if (node.type === "agent" && !node.data.prompt?.trim()) {
      warnings.push(`${node.data.label || node.id} has no instruction.`);
    }
    if (node.type === "validator" && !node.data.assertion?.trim()) {
      warnings.push(`${node.data.label || node.id} has no assertion rule.`);
    }
    if (node.type === "router" && !node.data.condition?.trim()) {
      warnings.push(`${node.data.label || node.id} has no condition.`);
    }
  }

  for (const edge of edges) {
    if (!ids.has(edge.source)) errors.push(`Edge ${edge.id} references missing source ${edge.source}.`);
    if (!ids.has(edge.target)) errors.push(`Edge ${edge.id} references missing target ${edge.target}.`);
    if (edge.source === edge.target) errors.push(`Edge ${edge.id} is a self-loop.`);
  }

  const outgoing = new Map<string, string[]>();
  for (const node of nodes) outgoing.set(node.id, []);
  for (const edge of edges) {
    if (outgoing.has(edge.source)) outgoing.get(edge.source)!.push(edge.target);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): string | null => {
    if (visiting.has(id)) return `DAG cycle detected: ${[...path, id].join(" → ")}.`;
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      const error = visit(next, [...path, id]);
      if (error) return error;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const node of nodes) {
    const error = visit(node.id, []);
    if (error) {
      errors.push(error);
      break;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

export function defaultCanvasTopology(agents: Agent[]): CanvasTopology {
  const product = agents.find((agent) => /product/i.test(agent.role)) ?? agents[0];
  const developer = agents.find((agent) => /developer/i.test(agent.role)) ?? agents[1] ?? agents[0];
  const qa = agents.find((agent) => /qa/i.test(agent.role)) ?? agents[2] ?? agents[0];
  const now = Date.now();
  const make = (
    id: string,
    type: CanvasNodeData["kind"],
    label: string,
    x: number,
    y: number,
    data: Partial<CanvasNodeData>,
  ) => ({
    id,
    type,
    position: { x, y },
    data: {
      label,
      kind: type,
      status: "idle" as const,
      ...data,
    },
  });
  return {
    version: 1,
    updatedAt: now,
    nodes: [
      make("agent-spec", "agent", "Spec", 40, 80, {
        agentId: product?.id,
        modelKey: product?.modelKey,
        prompt: "Turn the brief into acceptance criteria and a compact specification.",
      }),
      make("validator-spec", "validator", "Spec gate", 320, 80, {
        assertion: "contains: acceptance criteria",
      }),
      make("agent-build", "agent", "Build", 600, 80, {
        agentId: developer?.id,
        modelKey: developer?.modelKey,
        prompt:
          "Implement the approved specification. Emit fenced files with path= annotations.",
      }),
      make("router-quality", "router", "Quality router", 880, 80, {
        condition: "score>=70",
      }),
      make("validator-tests", "validator", "Test gate", 1160, 80, {
        assertion: "contains: test",
      }),
      make("agent-qa", "agent", "Verify", 1440, 80, {
        agentId: qa?.id,
        modelKey: qa?.modelKey,
        prompt:
          "Review the implementation against the acceptance criteria. List failing cases or approve.",
      }),
    ],
    edges: [
      { id: "e1", source: "agent-spec", target: "validator-spec", animated: true },
      { id: "e2", source: "validator-spec", target: "agent-build", animated: true },
      { id: "e3", source: "agent-build", target: "router-quality", animated: true },
      { id: "e4", source: "router-quality", target: "validator-tests", label: "pass", animated: true },
      { id: "e5", source: "validator-tests", target: "agent-qa", animated: true },
    ],
  };
}
