import type { Agent, CanvasNodeData, CanvasTopology } from "../types";

/**
 * Pure canvas helpers. This module must stay free of Node-only imports because
 * the React Flow editor imports it in the browser.
 */
export function validateCanvasTopology(
  topology: CanvasTopology,
  agents?: Agent[],
): {
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
  if (!nodes.length) errors.push("The canvas has no nodes.");
  const ids = new Set<string>();
  const validKinds = new Set<CanvasNodeData["kind"]>(["agent", "validator", "router"]);
  const agentById = agents ? new Map(agents.map((agent) => [agent.id, agent])) : null;
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const node of nodes) {
    if (!node.id) errors.push("A node is missing its id.");
    if (!node.data?.label?.trim()) warnings.push(`Node ${node.id} has no label.`);
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}.`);
    ids.add(node.id);
    if (!validKinds.has(node.type)) {
      errors.push(`Node ${node.data?.label || node.id} has unsupported type "${node.type}".`);
    } else if (node.data.kind !== node.type) {
      warnings.push(
        `${node.data.label || node.id} declares kind "${node.data.kind}" but is rendered as "${node.type}".`,
      );
    }
    if (node.type === "agent") {
      if (!node.data.agentId) {
        warnings.push(`${node.data.label || node.id} has no agent assigned and will fall back to the first enabled agent.`);
      } else if (agentById && !agentById.has(node.data.agentId)) {
        errors.push(`${node.data.label || node.id} references missing agent ${node.data.agentId}.`);
      } else if (agentById && !agentById.get(node.data.agentId)?.enabled) {
        warnings.push(`${node.data.label || node.id} is assigned to a disabled agent.`);
      }
      if (!node.data.prompt?.trim()) {
        warnings.push(`${node.data.label || node.id} has no instruction.`);
      }
    }
    if (node.type === "validator" && !node.data.assertion?.trim()) {
      warnings.push(`${node.data.label || node.id} has no assertion rule.`);
    }
    if (node.type === "router" && !node.data.condition?.trim()) {
      warnings.push(`${node.data.label || node.id} has no condition.`);
    }
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.source)) errors.push(`Edge ${edge.id} references missing source ${edge.source}.`);
    if (!ids.has(edge.target)) errors.push(`Edge ${edge.id} references missing target ${edge.target}.`);
    if (edge.source === edge.target) errors.push(`Edge ${edge.id} is a self-loop.`);
    const key = `${edge.source}->${edge.target}:${edge.label ?? ""}`;
    if (edgeKeys.has(key)) {
      warnings.push(`Duplicate edge ${edge.source} → ${edge.target}${edge.label ? ` (${edge.label})` : ""}.`);
    }
    edgeKeys.add(key);
    if (incoming.has(edge.target)) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    if (outgoing.has(edge.source)) outgoing.get(edge.source)!.push(edge.target);
  }

  for (const node of nodes) {
    if (node.type !== "router") continue;
    const routerEdges = edges.filter((edge) => edge.source === node.id);
    if (!routerEdges.length) {
      warnings.push(`${node.data.label || node.id} is a router with no outgoing branches.`);
      continue;
    }
    for (const edge of routerEdges) {
      if (edge.label && edge.label !== "pass" && edge.label !== "fail") {
        warnings.push(
          `Router ${node.data.label || node.id} has an unrecognised branch label "${edge.label}" (expected pass or fail).`,
        );
      }
    }
    if (!routerEdges.some((edge) => (edge.label ?? "pass") === "pass")) {
      warnings.push(`${node.data.label || node.id} has no pass branch; downstream work can never run.`);
    }
    if (!routerEdges.some((edge) => edge.label === "fail")) {
      warnings.push(`${node.data.label || node.id} has no fail branch; failures have nowhere to route.`);
    }
  }

  if (nodes.length > 1) {
    for (const node of nodes) {
      if ((incoming.get(node.id) ?? 0) === 0 && (outgoing.get(node.id)?.length ?? 0) === 0) {
        warnings.push(
          `${node.data.label || node.id} is isolated — connect it before activating the DAG.`,
        );
      }
    }
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
