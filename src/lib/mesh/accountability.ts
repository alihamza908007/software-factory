import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Agent } from "../types";
import { uid } from "../utils";
import { meshBus } from "./event-bus";

export type TaskContractStatus =
  | "PENDING_ACCEPTANCE"
  | "ACCEPTED"
  | "REJECTED"
  | "BLOCKED"
  | "COMPLETED";

export interface RuntimeProof {
  commandExecuted: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timestamp: string;
}

export interface PreFlightContext {
  workspaceRoot?: string;
  /** Workspace-relative file tree snapshot. Absolute paths are normalised. */
  fileTree?: string[];
  projectId?: string;
  threadId?: string;
  runId?: string;
  /** Capability alignment must be strictly greater than this value. */
  threshold?: number;
  /** Set false for pure simulations; production execution leaves this enabled. */
  publish?: boolean;
}

export interface PreFlightResult {
  passed: boolean;
  capabilityScore: number;
  capabilityPassed: boolean;
  dependenciesPassed: boolean;
  checkedInputs: string[];
  missingInputs: string[];
  missingDirectories: string[];
  reason: string;
  resolutionPath?: string;
  checkedAt: number;
}

interface TaskContractBase {
  taskId: string;
  sourceAgent: string;
  targetAgent: string;
  objective: string;
  requiredArtifacts: string[];
  /** Upstream files/directories that must exist before the task can start. */
  requiredInputs?: string[];
  requiredDirectories?: string[];
  maxTokenBudget: number;
  requiredCapabilities: string[];
  reason?: string;
  /** Mandatory readiness verdict captured when the contract was offered. */
  preflight?: PreFlightResult;
}

export type TaskContract = TaskContractBase & (
  | { status: "COMPLETED"; runtimeProof: RuntimeProof }
  | { status: Exclude<TaskContractStatus, "COMPLETED">; runtimeProof?: RuntimeProof }
);

export function createTaskContract(
  input: Omit<TaskContractBase, "taskId" | "requiredCapabilities"> & {
    requiredCapabilities?: string[];
  },
): TaskContract {
  return {
    ...input,
    taskId: uid("task"),
    status: "PENDING_ACCEPTANCE",
    requiredCapabilities: input.requiredCapabilities ?? inferRequiredCapabilities(input.objective),
  };
}

export function completeTaskContract(
  contract: TaskContract,
  proof?: RuntimeProof,
  postFlight?: { passed: boolean; resolutionPath?: string; summary?: string | { summary: string } },
): TaskContract {
  if (
    !proof ||
    proof.exitCode !== 0 ||
    typeof proof.commandExecuted !== "string" ||
    !proof.commandExecuted.trim() ||
    typeof proof.stdout !== "string" ||
    typeof proof.stderr !== "string" ||
    !Number.isFinite(Date.parse(proof.timestamp))
  ) {
    return {
      ...contract,
      status: "REJECTED",
      reason: "Task rejected: Missing mandatory runtime proof. Execute the build, test, or server check and provide terminal output.",
    };
  }
  if (postFlight && !postFlight.passed) {
    const detail = typeof postFlight.summary === "string" ? postFlight.summary : postFlight.summary?.summary;
    return {
      ...contract,
      status: "BLOCKED",
      reason: `Task blocked by post-flight checks: ${detail ?? postFlight.resolutionPath ?? "artifact verification failed"}`,
      runtimeProof: proof,
    };
  }
  return { ...contract, status: "COMPLETED", runtimeProof: proof, reason: "Runtime proof and post-flight checks passed." };
}

const capabilityTerms: Record<string, string[]> = {
  "frontend/ui/react": ["frontend", "front-end", "ui", "ux", "react", "component", "css", "tailwind", "page", "layout", "accessibility", "responsive"],
  "backend/api/data": ["backend", "back-end", "api", "route", "server", "database", "sql", "prisma", "schema", "endpoint", "auth"],
  "qa/testing": ["qa", "test", "testing", "jest", "vitest", "playwright", "coverage", "regression", "assertion", "validation"],
  "security/audit": ["security", "secure", "audit", "vulnerability", "injection", "secret", "permission", "threat", "owasp"],
  "architecture/design": ["architecture", "architect", "design", "system", "module boundary", "scalability", "trade-off", "contract"],
  "devops/platform": ["devops", "deploy", "deployment", "ci/cd", "pipeline", "docker", "infra", "infrastructure", "monitoring", "release"],
  "product/requirements": ["product", "requirement", "user story", "acceptance criteria", "scope", "specification", "stakeholder", "prioritize"],
};

export const PREFLIGHT_CAPABILITY_THRESHOLD = 0.8;

function hasCapabilityTerm(normalized: string, term: string): boolean {
  if (term.includes(" ") || term.includes("/") || term.includes("-")) {
    return normalized.includes(term);
  }
  return new RegExp(`(?:^|[^a-z0-9])${term}(?:[^a-z0-9]|$)`, "i").test(normalized);
}

export function inferRequiredCapabilities(objective: string): string[] {
  const normalized = objective.toLowerCase();
  return Object.entries(capabilityTerms)
    .filter(([, terms]) => terms.some((term) => hasCapabilityTerm(normalized, term)))
    .map(([capability]) => capability);
}

/**
 * A handoff transfers only the residual work that the sender does not already
 * own. Without this, a Product Manager's implementation handoff inherits the
 * whole conversation (including product/requirements) and the developer is
 * rejected for not also being the product owner.
 */
export function scopeHandoffCapabilities(source: Agent, objective: string): string[] {
  const required = inferRequiredCapabilities(objective);
  if (!required.length) return [];
  const sourceCapabilities = new Set(agentCapabilities(source));
  const residual = required.filter((capability) => !sourceCapabilities.has(capability));
  return residual.length ? residual : required;
}

export function agentCapabilities(agent: Agent): string[] {
  const declared = (agent.capabilities ?? []).map((item) => item.toLowerCase());
  const profile = `${agent.name} ${agent.handle} ${agent.role} ${agent.description} ${agent.systemPrompt} ${declared.join(" ")}`.toLowerCase();
  const capabilities = new Set([
    ...declared,
    ...inferRequiredCapabilities(declared.join(" ")),
    ...inferRequiredCapabilities(profile),
  ]);

  // A generalist developer is explicitly registered for both implementation
  // domains. Without this, a multi-domain feature can never clear a strict
  // capability gate even when the developer is the correct owner.
  if (/\b(?:developer|software engineer|frontend engineer|backend engineer|full[- ]?stack)\b/i.test(`${agent.name} ${agent.role}`) || /full[- ]?stack/i.test(profile)) {
    capabilities.add("frontend/ui/react");
    capabilities.add("backend/api/data");
  }
  if (/product|manager|supervisor/i.test(`${agent.name} ${agent.role}`)) {
    capabilities.add("product/requirements");
  }
  if (/qa|quality|test/i.test(`${agent.name} ${agent.role}`)) {
    capabilities.add("qa/testing");
  }
  if (/architect|systems/i.test(`${agent.name} ${agent.role}`)) {
    capabilities.add("architecture/design");
  }
  return Array.from(capabilities);
}

export function capabilityScore(agent: Agent, required: string[]): number {
  if (!required.length) return 1;
  const capabilities = new Set(agentCapabilities(agent));
  return required.filter((item) => capabilities.has(item)).length / required.length;
}

function normalizeTreePath(value: string, workspaceRoot?: string): string {
  let normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  }
  return normalized;
}

/**
 * The file-tree snapshot is intentionally capped for prompt size, so a long
 * project can omit an existing dependency. When a workspace root is attached,
 * verify the exact required path on disk before declaring it missing.
 */
function existsOnDisk(
  workspaceRoot: string,
  relative: string,
  kind: "file" | "directory",
): boolean {
  const normalized = normalizeTreePath(relative, workspaceRoot);
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) return false;
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return false;
  try {
    if (!existsSync(absolute)) return false;
    const stat = statSync(absolute);
    return kind === "directory" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function missingDependencyResolution(
  contract: TaskContract,
  missingInputs: string[],
  missingDirectories: string[],
): string {
  const missing = [...missingInputs, ...missingDirectories.map((dir) => `${dir.replace(/\/$/, "")}/`)];
  const first = missing[0] ?? "the required dependency";
  const objective = contract.objective.toLowerCase();
  if (/schema|prisma|database/.test(first) && /(ui|table|form|page|component)/.test(objective)) {
    return `Waiting for backend schema generation at ${first} before building the UI tables. Generate and validate ${first} in the upstream data task, then resend this contract with an updated fileTree snapshot.`;
  }
  if (/package\.json|lock/.test(first)) {
    return `Restore ${first} in the workspace (run the scaffold/install step) before ${contract.targetAgent} accepts "${contract.objective.slice(0, 120)}". Reattach the workspace snapshot after the manifest exists.`;
  }
  return `Provide ${missing.join(", ")} before ${contract.targetAgent} starts "${contract.objective.slice(0, 140)}". Generate the missing dependency in an upstream task or attach a workspace snapshot that contains it, then retry the handoff.`;
}

/**
 * Mandatory readiness gate. It is deliberately synchronous: every execution
 * loop has the file tree snapshot in hand and must make an explicit decision
 * before spending model tokens.
 */
export function runPreFlight(
  contract: TaskContract,
  agent: Agent,
  context: PreFlightContext = {},
): PreFlightResult {
  const threshold = context.threshold ?? PREFLIGHT_CAPABILITY_THRESHOLD;
  const score = capabilityScore(agent, contract.requiredCapabilities);
  const capabilityPassed = score > threshold;
  const fileTree = (context.fileTree ?? []).map((file) => normalizeTreePath(file, context.workspaceRoot));
  const tree = new Set(fileTree);
  const checkedInputs = Array.from(new Set([
    ...(contract.requiredInputs ?? []).map((input) => normalizeTreePath(input, context.workspaceRoot)),
    ...(contract.requiredDirectories ?? []).map((dir) => normalizeTreePath(dir, context.workspaceRoot).replace(/\/+$/, "")),
  ])).filter(Boolean);
  const missingInputs = (contract.requiredInputs ?? [])
    .map((input) => normalizeTreePath(input, context.workspaceRoot))
    .filter(
      (input) =>
        input &&
        !tree.has(input) &&
        !(context.workspaceRoot && existsOnDisk(context.workspaceRoot, input, "file")),
    );
  const missingDirectories = (contract.requiredDirectories ?? [])
    .map((dir) => normalizeTreePath(dir, context.workspaceRoot).replace(/\/+$/, ""))
    .filter(
      (dir) =>
        dir &&
        !fileTree.some((file) => file === dir || file.startsWith(`${dir}/`)) &&
        !(context.workspaceRoot && existsOnDisk(context.workspaceRoot, dir, "directory")),
    );
  // A root without a precomputed tree is still a valid snapshot: exact
  // dependencies are verified directly on disk above.
  const hasSnapshot = Boolean(context.workspaceRoot) || fileTree.length > 0;
  const dependenciesPassed = !checkedInputs.length || (hasSnapshot && !missingInputs.length && !missingDirectories.length);

  let reason: string;
  let resolutionPath: string | undefined;
  if (!agent.enabled) {
    reason = `${agent.name} is disabled and cannot accept work.`;
    resolutionPath = `Enable ${agent.name} in Agent Manager or reroute this contract to an enabled peer.`;
  } else if (!capabilityPassed) {
    reason = `Capability alignment ${Math.round(score * 100)}% does not exceed the required ${Math.round(threshold * 100)}% for ${contract.requiredCapabilities.join(", ") || "this task"}.`;
    resolutionPath = `Reroute the contract to an agent whose registered capabilities cover ${contract.requiredCapabilities.join(", ")}. Do not let ${agent.name} accept work outside its capability profile.`;
  } else if (!dependenciesPassed) {
    reason = !hasSnapshot
      ? `No workspace file-tree snapshot is attached, so ${agent.name} cannot verify required inputs (${checkedInputs.join(", ")}).`
      : `Required workspace dependencies are missing: ${[...missingInputs, ...missingDirectories].join(", ")}.`;
    resolutionPath = missingDependencyResolution(contract, missingInputs, missingDirectories);
  } else {
    reason = `Pre-flight passed: capability alignment ${Math.round(score * 100)}% and ${checkedInputs.length} dependenc${checkedInputs.length === 1 ? "y" : "ies"} verified.`;
  }

  return {
    passed: agent.enabled && capabilityPassed && dependenciesPassed,
    capabilityScore: score,
    capabilityPassed,
    dependenciesPassed,
    checkedInputs,
    missingInputs,
    missingDirectories,
    reason,
    resolutionPath,
    checkedAt: Date.now(),
  };
}

function publishPreFlightBlocked(
  contract: TaskContract,
  agent: Agent,
  preflight: PreFlightResult,
  context: PreFlightContext,
): void {
  if (preflight.passed || context.publish === false) return;
  meshBus.publish({
    type: "PRE_FLIGHT_BLOCKED",
    source: agent.name,
    target: contract.sourceAgent,
    agentId: agent.id,
    threadId: context.threadId,
    projectId: context.projectId,
    runId: context.runId,
    severity: "error",
    title: `Pre-flight blocked · ${agent.name}`,
    message: `${preflight.reason}${preflight.resolutionPath ? `\nresolutionPath: ${preflight.resolutionPath}` : ""}`,
    payload: {
      contract,
      preflight,
      resolutionPath: preflight.resolutionPath,
      fileTree: context.fileTree ?? [],
      workspaceRoot: context.workspaceRoot,
      requiredCapabilities: contract.requiredCapabilities,
      capabilityScore: preflight.capabilityScore,
    },
  });
}

/** Accept, reject, or block a contract only after the mandatory readiness gate. */
export function acceptTask(
  contract: TaskContract,
  agent: Agent,
  context: PreFlightContext = {},
): TaskContract {
  const preflight = runPreFlight(contract, agent, context);
  publishPreFlightBlocked(contract, agent, preflight, context);
  if (!preflight.passed) {
    return {
      ...contract,
      status: preflight.dependenciesPassed ? "REJECTED" : "BLOCKED",
      preflight,
      reason: preflight.reason,
    };
  }
  return {
    ...contract,
    status: "ACCEPTED",
    preflight,
    reason: preflight.reason,
  };
}

export function routeTask(agents: Agent[], objective: string, preferred?: Agent): { agent?: Agent; redirected: boolean; reason?: string } {
  const required = inferRequiredCapabilities(objective);
  if (!required.length) return { agent: preferred ?? agents.find((item) => item.enabled), redirected: false };
  const ranked = agents.filter((agent) => agent.enabled)
    .map((agent) => ({ agent, score: capabilityScore(agent, required) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score <= PREFLIGHT_CAPABILITY_THRESHOLD) {
    return {
      agent: preferred && capabilityScore(preferred, required) > PREFLIGHT_CAPABILITY_THRESHOLD ? preferred : undefined,
      redirected: false,
      reason: `No enabled agent exceeds the ${Math.round(PREFLIGHT_CAPABILITY_THRESHOLD * 100)}% capability threshold for ${required.join(", ")}. Split the objective into domain-scoped contracts before execution.`,
    };
  }
  if (preferred && capabilityScore(preferred, required) > PREFLIGHT_CAPABILITY_THRESHOLD) {
    return { agent: preferred, redirected: false };
  }
  return {
    agent: best.agent,
    redirected: best.agent.id !== preferred?.id,
    reason: preferred ? `${preferred.name} did not exceed the capability threshold for ${required.join(", ")}; routed to ${best.agent.name}.` : undefined,
  };
}

export function contractPrompt(contract: TaskContract): string {
  return [
    "TASK ACCOUNTABILITY CONTRACT — evaluate this before doing the task.",
    `Task: ${contract.taskId}`,
    `From: ${contract.sourceAgent}`,
    `To: ${contract.targetAgent}`,
    `Objective: ${contract.objective}`,
    `Required capabilities: ${contract.requiredCapabilities.join(", ") || "general"}`,
    `Required inputs: ${(contract.requiredInputs ?? []).join(", ") || "none specified"}`,
    `Required artifacts: ${contract.requiredArtifacts.join(", ") || "none specified"}`,
    `Output token ceiling: ${contract.maxTokenBudget}`,
    "PRE-FLIGHT: you may not accept this task blindly. Confirm the objective matches your registered capabilities, and confirm every required input exists in the supplied fileTree snapshot. If either check fails, begin with TASK_REJECTED: and include the missing capability/input plus a concrete resolutionPath; do not guess or start implementing.",
    "Accept only if this objective is within your role and the provided context is sufficient. If accepted, begin with TASK_ACCEPTED on the first line, then continue in the same response and complete the objective. The acceptance marker is only an acknowledgement; it is never the answer or a completion signal. If unable, begin with TASK_REJECTED: followed by a concise reason, and do not attempt the task.",
    "POST-FLIGHT: before claiming completion, verify every output path exists and is non-empty, reject TODO/placeholder implementations, and report a three-sentence handoff summary plus the modified file pointers.",
    "RESOLUTION-FIRST: if blocked, include a specific resolutionPath (file fix or approved command) and the exact diagnostic; do not stop at a warning. Use the supplied absolute workspace root and fileTree snapshot as the source of truth. Before implementation, verify route-extension uniqueness and required config files.",
  ].join("\n");
}
