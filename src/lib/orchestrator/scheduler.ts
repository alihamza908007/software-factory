import { listAgents, getSettings } from "../db";
import { generateWithAgent } from "../providers/router";
import type {
  Agent,
  CanvasNodeData,
  CanvasTopology,
  GuardrailResult,
  ModelProvider,
} from "../types";
import { classifyHandoff, hashPayload } from "./guardrails";
import { applyFileBlocks, parseFileBlocks } from "./parse";
import { meshBus, publishScopeAdvisories, setMeshAgentStatus } from "../mesh/event-bus";
import { tokenBudgetForTask } from "../mesh/context-manager";
import {
  acceptTask,
  createTaskContract,
  inferRequiredCapabilities,
  routeTask,
} from "../mesh/accountability";
import { verifyPostFlight } from "../mesh/validators";
import { listWorkspaceFiles } from "../workspace";

export type DagNodeStatus = "pending" | "queued" | "running" | "passed" | "failed" | "blocked";

export interface DagNodeContext<TInput = unknown> {
  node: DagNode<TInput>;
  upstream: Map<string, unknown>;
  signal?: AbortSignal;
  emit: (event: DagEvent) => void;
}

export interface DagNode<TInput = unknown> {
  id: string;
  label: string;
  kind?: "agent" | "validator" | "router" | "task";
  dependsOn: string[];
  run: (context: DagNodeContext<TInput>) => Promise<unknown>;
}

export interface DagEvent {
  type: "start" | "complete" | "failed" | "skipped" | "blocked" | "log";
  nodeId: string;
  label?: string;
  status?: DagNodeStatus;
  detail?: string;
  output?: unknown;
  error?: string;
  durationMs?: number;
  tokens?: number;
  outputPreview?: string;
  at: number;
}

export interface DagNodeResult {
  id: string;
  label: string;
  status: DagNodeStatus;
  output?: unknown;
  error?: string;
  durationMs?: number;
  tokens?: number;
  outputPreview?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface DagExecutionResult {
  ok: boolean;
  nodes: DagNodeResult[];
  outputs: Record<string, unknown>;
  errors: Array<{ nodeId: string; error: string }>;
  durationMs: number;
}

function assertAcyclic(nodes: DagNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("DAG contains duplicate node ids.");
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`Node ${node.id} depends on unknown node ${dependency}.`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (visiting.has(id)) {
      throw new Error(`DAG cycle detected: ${[...path, id].join(" → ")}.`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id, []);
}

/**
 * Execute independent branches with Promise.all and fan-in only when every
 * dependency has settled successfully. Local VRAM gates live one layer below
 * (resourceQueue), so cloud branches are effectively unlimited while heavy
 * local models remain serialised.
 */
export async function executeDag(
  nodes: DagNode[],
  options: { signal?: AbortSignal; emit?: (event: DagEvent) => void } = {},
): Promise<DagExecutionResult> {
  assertAcyclic(nodes);
  const startedAt = Date.now();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const results = new Map<string, DagNodeResult>(
    nodes.map((node) => [
      node.id,
      {
        id: node.id,
        label: node.label,
        status: "pending" as DagNodeStatus,
        ...(node.kind === "agent" ? { status: "queued" as DagNodeStatus } : {}),
      },
    ]),
  );
  const outputs = new Map<string, unknown>();
  const errors: Array<{ nodeId: string; error: string }> = [];
  const emit = (event: DagEvent) => options.emit?.(event);

  const runNode = async (node: DagNode): Promise<void> => {
    if (options.signal?.aborted) throw new DOMException("DAG aborted", "AbortError");
    const state = results.get(node.id)!;
    const upstream = new Map<string, unknown>();
    for (const dependency of node.dependsOn) {
      const result = results.get(dependency);
      if (!result || result.status !== "passed") {
        state.status = "blocked";
        state.error = `Upstream node ${dependency} did not pass.`;
        emit({
          type: "blocked",
          nodeId: node.id,
          label: node.label,
          status: "blocked",
          detail: state.error,
          at: Date.now(),
        });
        return;
      }
      upstream.set(dependency, outputs.get(dependency));
    }

    state.status = "running";
    state.startedAt = Date.now();
    emit({
      type: "start",
      nodeId: node.id,
      label: node.label,
      status: "running",
      at: Date.now(),
    });
    try {
      const output = await node.run({
        node,
        upstream,
        signal: options.signal,
        emit,
      });
      const skipped =
        Boolean(output) &&
        typeof output === "object" &&
        (output as Record<string, unknown>).skipped === true;
      state.output = output;
      state.completedAt = Date.now();
      state.durationMs = state.completedAt - state.startedAt;
      state.tokens = outputTokens(output);
      state.outputPreview = firstText(output).slice(0, 500);
      if (skipped) {
        state.status = "blocked";
        emit({
          type: "blocked",
          nodeId: node.id,
          label: node.label,
          status: "blocked",
          detail:
            (output as Record<string, unknown>).reason === "router"
              ? "Skipped by router branch."
              : "Node skipped.",
          output,
          durationMs: state.durationMs,
          tokens: state.tokens,
          outputPreview: state.outputPreview,
          at: Date.now(),
        });
        return;
      }
      state.status = "passed";
      outputs.set(node.id, output);
      emit({
        type: "complete",
        nodeId: node.id,
        label: node.label,
        status: "passed",
        output,
        durationMs: state.durationMs,
        tokens: state.tokens,
        outputPreview: state.outputPreview,
        at: Date.now(),
      });
    } catch (error) {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.completedAt = Date.now();
      state.durationMs = state.completedAt - (state.startedAt ?? state.completedAt);
      state.outputPreview = state.error.slice(0, 500);
      errors.push({ nodeId: node.id, error: state.error });
      emit({
        type: "failed",
        nodeId: node.id,
        label: node.label,
        status: "failed",
        detail: state.error,
        error: state.error,
        durationMs: state.durationMs,
        outputPreview: state.outputPreview,
        at: Date.now(),
      });
    }
  };

  const done = new Set<string>();
  while (done.size < nodes.length) {
    if (options.signal?.aborted) throw new DOMException("DAG aborted", "AbortError");
    const ready = nodes.filter((node) => {
      if (done.has(node.id)) return false;
      const state = results.get(node.id);
      if (state?.status !== "pending" && state?.status !== "queued") return false;
      return node.dependsOn.every((dependency) => done.has(dependency));
    });
    if (!ready.length) {
      for (const node of nodes) {
        if (done.has(node.id)) continue;
        const state = results.get(node.id);
        if (state?.status === "pending" || state?.status === "queued") {
          state.status = "blocked";
          state.error = "Unresolvable dependency graph.";
          emit({
            type: "blocked",
            nodeId: node.id,
            label: node.label,
            status: "blocked",
            detail: state.error,
            at: Date.now(),
          });
        }
        done.add(node.id);
      }
      break;
    }
    await Promise.all(ready.map((node) => runNode(node)));
    for (const node of ready) done.add(node.id);
  }

  const nodeResults = nodes.map((node) => results.get(node.id)!);
  return {
    ok: errors.length === 0 && nodeResults.every((node) => node.status !== "failed"),
    nodes: nodeResults,
    outputs: Object.fromEntries(outputs.entries()),
    errors,
    durationMs: Date.now() - startedAt,
  };
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.payload === "string") return record.payload;
    if (typeof record.output === "string") return record.output;
    return JSON.stringify(value);
  }
  return String(value ?? "");
}

function outputTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const metrics = (value as Record<string, unknown>).metrics as
    | { inputTokens?: unknown; outputTokens?: unknown }
    | undefined;
  const input = Number(metrics?.inputTokens ?? 0);
  const output = Number(metrics?.outputTokens ?? 0);
  if (!Number.isFinite(input + output) || input + output <= 0) return undefined;
  return input + output;
}

function upstreamText(upstream: Map<string, unknown>): string {
  return Array.from(upstream.values()).map(firstText).filter(Boolean).join("\n\n---\n\n");
}

function evaluateAssertion(assertion: string, payload: string): { passed: boolean; detail: string; score?: number } {
  const rule = assertion.trim();
  if (!rule) return { passed: payload.trim().length > 0, detail: "Non-empty payload check." };
  const contains = rule.match(/^contains:\s*(.+)$/i);
  if (contains) {
    const passed = payload.toLowerCase().includes(contains[1].toLowerCase());
    return { passed, detail: passed ? `Contains "${contains[1]}".` : `Missing required text "${contains[1]}".` };
  }
  const regex = rule.match(/^regex:\s*(.+)$/i);
  if (regex) {
    try {
      const passed = new RegExp(regex[1], "i").test(payload);
      return { passed, detail: passed ? "Regular expression matched." : "Regular expression did not match." };
    } catch (error) {
      return { passed: false, detail: `Invalid regex: ${String(error)}` };
    }
  }
  const minLength = rule.match(/^(?:minLength|length)\s*>?=\s*(\d+)$/i);
  if (minLength) {
    const passed = payload.length >= Number(minLength[1]);
    return { passed, detail: `${payload.length} characters (minimum ${minLength[1]}).` };
  }
  const score = rule.match(/^score\s*>?=\s*(\d+)$/i);
  if (score) {
    const result = classifyHandoff({
      sourceAgent: { id: "validator", name: "Validator", handle: "validator", role: "validator" },
      targetAgent: { id: "validator", name: "Validator", handle: "validator", role: "reviewer" },
      payload,
      threshold: 0,
    });
    return {
      passed: result.score >= Number(score[1]),
      detail: `Guardrail score ${result.score}/100 (required ${score[1]}).`,
      score: result.score,
    };
  }
  const passed = payload.toLowerCase().includes(rule.toLowerCase());
  return { passed, detail: passed ? `Contains "${rule}".` : `Does not contain "${rule}".` };
}

function evaluateRouter(condition: string, payload: string): { branch: "pass" | "fail"; detail: string; score?: number } {
  const rule = condition.trim() || "true";
  if (/^(true|always|pass)$/i.test(rule)) return { branch: "pass", detail: "Router always passes." };
  if (/^(false|never|fail)$/i.test(rule)) return { branch: "fail", detail: "Router always fails." };
  const result = evaluateAssertion(rule, payload);
  return {
    branch: result.passed ? "pass" : "fail",
    detail: result.detail,
    score: result.score,
  };
}

export interface CanvasRunEvent {
  type: "canvas_start" | "node" | "log" | "canvas_done" | "canvas_error";
  nodeId?: string;
  status?: DagNodeStatus;
  detail?: string;
  score?: number;
  error?: string;
  durationMs?: number;
  tokens?: number;
  outputPreview?: string;
  result?: DagExecutionResult;
  at: number;
}

export async function executeCanvasTopology(
  topology: CanvasTopology,
  options: {
    signal?: AbortSignal;
    emit?: (event: CanvasRunEvent) => void;
    maxNodes?: number;
    initialInput?: string;
    projectDir?: string;
    projectId?: string;
    runId?: string;
    applyArtifacts?: boolean;
  } = {},
): Promise<DagExecutionResult> {
  const nodes = topology.nodes ?? [];
  const edges = topology.edges ?? [];
  if (!nodes.length) throw new Error("The canvas has no nodes.");
  if (nodes.length > (options.maxNodes ?? 16)) {
    throw new Error(`Canvas execution is capped at ${options.maxNodes ?? 16} nodes.`);
  }

  const agents = await listAgents();
  const enabled = agents.filter((agent) => agent.enabled);
  const byNode = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    if (!byNode.has(edge.source)) throw new Error(`Edge ${edge.id} has unknown source ${edge.source}.`);
    if (!byNode.has(edge.target)) throw new Error(`Edge ${edge.id} has unknown target ${edge.target}.`);
  }

  const dagNodes: DagNode[] = nodes.map((canvasNode) => {
    const dependsOn = edges
      .filter((edge) => edge.target === canvasNode.id)
      .map((edge) => edge.source);
    const kind = canvasNode.type;

    return {
      id: canvasNode.id,
      label: canvasNode.data.label || canvasNode.id,
      kind,
      dependsOn,
      run: async ({ upstream, signal, emit }) => {
        const payload = upstreamText(upstream);
        const previous = Array.from(upstream.keys());
        // Conditional edges: a router emits {branch:"pass"|"fail"}. Edges
        // labelled pass/fail only continue when the branch matches.
        const incoming = edges.filter((edge) => edge.target === canvasNode.id);
        for (const edge of incoming) {
          const from = upstream.get(edge.source) as { branch?: string } | undefined;
          if (from?.branch && edge.label && edge.label !== from.branch) {
            emit({
              type: "log",
              nodeId: canvasNode.id,
              label: canvasNode.data.label,
              detail: `Skipped: edge ${edge.source}→${canvasNode.id} expects ${edge.label}, router returned ${from.branch}.`,
              at: Date.now(),
            });
            return { text: payload, skipped: true, reason: "router", branch: from.branch };
          }
        }
        if (kind === "validator") {
          const check = evaluateAssertion(canvasNode.data.assertion ?? "", payload);
          emit({
            type: "log",
            nodeId: canvasNode.id,
            label: canvasNode.data.label,
            detail: check.detail,
            at: Date.now(),
          });
          if (!check.passed) throw new Error(check.detail);
          return { text: payload, assertion: canvasNode.data.assertion, score: check.score, passed: true };
        }
        if (kind === "router") {
          const route = evaluateRouter(canvasNode.data.condition ?? "", payload);
          emit({
            type: "log",
            nodeId: canvasNode.id,
            label: canvasNode.data.label,
            detail: `${route.branch}: ${route.detail}`,
            at: Date.now(),
          });
          // A router is a gate: the fail branch blocks downstream nodes unless
          // they explicitly depend on a pass-labelled edge. The canvas labels
          // edges with pass/fail so the user can model both paths.
          return { text: payload, branch: route.branch, detail: route.detail, score: route.score };
        }

        // Agent node.
        let agent =
          enabled.find((item) => item.id === canvasNode.data.agentId) ??
          enabled.find((item) => item.handle === canvasNode.data.label.toLowerCase()) ??
          enabled[0];
        if (!agent) throw new Error("No enabled agent is available for the canvas node.");

        const nodePrompt =
          canvasNode.data.prompt?.trim() ||
          "Advance the workflow using the upstream payload. Return a concrete, reviewable result.";
        const canvasFileTree = options.projectDir
          ? await listWorkspaceFiles(options.projectDir, 160).catch(() => [])
          : [];
        let contract = createTaskContract({
          sourceAgent: previous[0] ?? "Canvas orchestrator",
          targetAgent: agent.name,
          objective: `${canvasNode.data.label}: ${nodePrompt}`,
          requiredArtifacts: [],
          requiredCapabilities: inferRequiredCapabilities(`${canvasNode.data.label}\n${nodePrompt}`),
          maxTokenBudget: tokenBudgetForTask(`${nodePrompt}\n${payload}`),
        });
        contract = acceptTask(contract, agent, {
          workspaceRoot: options.projectDir,
          fileTree: canvasFileTree,
          projectId: options.projectId,
          runId: options.runId,
        });
        if (contract.status !== "ACCEPTED") {
          const reroute = contract.status === "REJECTED"
            ? routeTask(enabled.filter((item) => item.id !== agent?.id), `${canvasNode.data.label}\n${nodePrompt}`)
            : undefined;
          if (!reroute?.agent) {
            throw new Error(`${agent.name} could not accept canvas node "${canvasNode.data.label}": ${contract.reason ?? "pre-flight blocked"}${contract.preflight?.resolutionPath ? `\nresolutionPath: ${contract.preflight.resolutionPath}` : ""}`);
          }
          agent = reroute.agent;
          contract = acceptTask({ ...contract, targetAgent: agent.name, status: "PENDING_ACCEPTANCE", reason: undefined }, agent, {
            workspaceRoot: options.projectDir,
            fileTree: canvasFileTree,
            projectId: options.projectId,
            runId: options.runId,
          });
          if (contract.status !== "ACCEPTED") {
            throw new Error(`${agent.name} could not accept rerouted canvas node "${canvasNode.data.label}": ${contract.reason ?? "pre-flight blocked"}`);
          }
          emit({
            type: "log",
            nodeId: canvasNode.id,
            label: canvasNode.data.label,
            detail: `Capability reroute → ${agent.name}.`,
            at: Date.now(),
          });
        }
        meshBus.publish({
          type: "TASK_CONTRACT",
          source: "Canvas orchestrator",
          target: `@${agent.handle.replace(/^@/, "")}`,
          agentId: agent.id,
          targetAgentId: agent.id,
          projectId: options.projectId,
          runId: options.runId,
          severity: "info",
          title: `Canvas task accepted · ${agent.name}`,
          message: contract.reason ?? contract.objective.slice(0, 500),
          payload: { contract },
        });
        const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
          { role: "system", content: agent.systemPrompt },
          {
            role: "user",
            content: [
              nodePrompt,
              payload ? `Upstream payload:\n${payload}` : options.initialInput ? `Build brief:\n${options.initialInput}` : "",
              "Return a complete result. If you emit files, use fenced blocks with `path=` annotations.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ];
        setMeshAgentStatus(agent.id, "executing", `Canvas · ${canvasNode.data.label}`);
        const outcome = await generateWithAgent({
          agent,
          messages,
          purpose: `canvas · ${canvasNode.data.label}`,
          signal,
          priority: 7,
          maxTokens: tokenBudgetForTask(`${nodePrompt}\n${payload}`),
          projectDir: options.projectDir,
          runId: options.runId,
          onStatus: (status) =>
            emit({
              type: "log",
              nodeId: canvasNode.id,
              label: canvasNode.data.label,
              detail: status.message,
              at: Date.now(),
            }),
        });
        setMeshAgentStatus(agent.id, "idle", "Canvas node complete");
        publishScopeAdvisories(agent.name, outcome.result.text, {
          agentId: agent.id,
          projectId: options.projectId,
          runId: options.runId,
        });
        const generatedFiles = parseFileBlocks(outcome.result.text);
        let appliedFiles: string[] = [];
        let applyErrors: Array<{ path: string; error: string }> = [];
        if (generatedFiles.length && options.applyArtifacts && options.projectDir) {
          const applied = await applyFileBlocks(options.projectDir, generatedFiles);
          appliedFiles = applied.written;
          applyErrors = applied.errors;
        }
        if (generatedFiles.length) {
          meshBus.publish({
            type: "ARTIFACT_CREATED",
            source: agent.name,
            agentId: agent.id,
            projectId: options.projectId,
            runId: options.runId,
            severity: applyErrors.length ? "warning" : "info",
            title: `${agent.name} published canvas artifacts`,
            message: generatedFiles.map((file) => file.path).slice(0, 12).join(", "),
            payload: {
              files: generatedFiles.map((file) => ({
                path: file.path,
                content: file.content,
              })),
              applied: appliedFiles,
              applyErrors,
            },
          });
        }
        contract = {
          ...contract,
          requiredArtifacts: options.applyArtifacts ? generatedFiles.map((file) => file.path) : [],
        };
        const postFlight = await verifyPostFlight({
          contract,
          agent,
          workspaceRoot: options.projectDir,
          fileTree: options.projectDir
            ? await listWorkspaceFiles(options.projectDir, 160).catch(() => [])
            : canvasFileTree,
          artifacts: generatedFiles.map((file) => ({ path: file.path, content: file.content })),
          projectId: options.projectId,
          runId: options.runId,
        });
        if (!postFlight.passed) {
          setMeshAgentStatus(agent.id, "error", "Post-flight blocked");
          throw new Error(
            `Post-flight blocked for "${canvasNode.data.label}": ${postFlight.findings.find((item) => item.severity === "error")?.detail ?? "artifact verification failed"}${postFlight.resolutionPath ? `\nresolutionPath: ${postFlight.resolutionPath}` : ""}`,
          );
        }

        const result: GuardrailResult = classifyHandoff({
          sourceAgent: {
            id: previous[0] ?? "canvas",
            name: previous[0] ?? "Canvas",
            handle: previous[0] ?? "canvas",
            role: "upstream",
          },
          targetAgent: {
            id: agent.id,
            name: agent.name,
            handle: agent.handle,
            role: agent.role,
          },
          payload: outcome.result.text,
          stage: "implementation",
          threshold: 0,
        });
        return {
          text: outcome.result.text,
          agent: agent.name,
          modelKey: outcome.model.key,
          provider: outcome.model.provider as ModelProvider,
          score: result.score,
          payloadHash: hashPayload(outcome.result.text),
          metrics: outcome.metric,
          files: appliedFiles,
          applyErrors,
          contract: { ...contract, status: "COMPLETED" as const },
          postFlight,
          handoffSummary: postFlight.summary,
        };
      },
    };
  });

  const settings = await getSettings();
  options.emit?.({
    type: "canvas_start",
    detail: `Parallel execution started · ${dagNodes.length} nodes · guardrail threshold ${settings.guardrailThreshold}.`,
    at: Date.now(),
  });

  return executeDag(dagNodes, {
    signal: options.signal,
    emit: (event) => {
      if (event.type === "start" || event.type === "complete" || event.type === "failed" || event.type === "blocked") {
        const output = event.output as { score?: number } | undefined;
        options.emit?.({
          type: "node",
          nodeId: event.nodeId,
          status: event.status,
          detail: event.detail ?? event.label,
          score: output?.score,
          error: event.error,
          durationMs: event.durationMs,
          tokens: event.tokens,
          outputPreview: event.outputPreview,
          at: event.at,
        });
      } else {
        options.emit?.({
          type: "log",
          nodeId: event.nodeId,
          detail: event.detail,
          at: event.at,
        });
      }
    },
  });
}


export { validateCanvasTopology, defaultCanvasTopology } from "../canvas/topology";
