import { promises as fs } from "node:fs";
import path from "node:path";
import { getRun, updateRun } from "@/lib/data/db";
import { PHASES } from "@/lib/core/constants";
import { runEvents } from "@/lib/core/events";

import { DeadLoopException, validateAgentHandoff } from "@/lib/pipeline/guardrails";
import type { Agent, GuardrailResult, PhaseId, Run } from "@/lib/core/types";
import { uid } from "@/lib/core/utils";

import { learnFromFailure } from "@/lib/mesh/agent-memory";
import { meshBus } from "@/lib/mesh/event-bus";

type ActiveRun = { controller: AbortController; cancelled: boolean };
const globalStore = globalThis as typeof globalThis & {
  __factoryActiveRuns?: Map<string, ActiveRun>;
};
export const activeRuns = (globalStore.__factoryActiveRuns ??= new Map<string, ActiveRun>());

export function phaseMeta(id: PhaseId) {
  return PHASES.find((phase) => phase.id === id)!;
}

export function findAgent(agents: Agent[], patterns: RegExp[], fallbackHandle?: string): Agent | undefined {
  return (
    agents.find((agent) => agent.enabled && patterns.some((pattern) => pattern.test(agent.role))) ??
    (fallbackHandle ? agents.find((agent) => agent.handle === fallbackHandle) : undefined) ??
    agents.find((agent) => agent.enabled)
  );
}

export function resolveAgents(agents: Agent[]): Record<PhaseId, Agent | undefined> {
  return {
    requirements: findAgent(agents, [/product/i, /manager/i], "product"),
    architecture: findAgent(agents, [/architect/i, /systems/i], "architect"),
    implementation: findAgent(agents, [/developer/i, /engineer/i, /full.?stack/i], "developer"),
    testing: findAgent(agents, [/qa/i, /test/i, /quality/i], "qa"),
    deployment: findAgent(agents, [/devops/i, /deploy/i, /platform/i, /sre/i], "devops"),
  };
}

export async function publishSnapshot(runId: string) {
  const run = await getRun(runId);
  if (run) runEvents.publish(runId, { type: "snapshot", run });
}

export async function logPhase(
  runId: string,
  phaseId: PhaseId,
  level: "info" | "warn" | "error" | "success" | "command" | "agent",
  message: string,
  detail?: string,
) {
  const run = await updateRun(runId, (run) => {
    const phase = run.phases.find((item) => item.id === phaseId);
    if (!phase) return;
    phase.logs.push({
      id: uid("log"),
      at: Date.now(),
      level,
      message,
      detail,
    });
    if (phase.logs.length > 260) phase.logs = phase.logs.slice(-260);
  });
  runEvents.publish(runId, {
    type: "log",
    runId,
    phaseId,
    log: {
      id: uid("log"),
      at: Date.now(),
      level,
      message,
      detail,
    },
  });
  if (run) {
    const phase = run.phases.find((item) => item.id === phaseId);
    if (phase) runEvents.publish(runId, { type: "phase", runId, phase });
  }
}

export async function guardHandoff(
  runId: string,
  phaseId: PhaseId,
  source: Agent,
  target: Agent,
  payload: string,
  stage: string,
): Promise<GuardrailResult> {
  const result = await validateAgentHandoff({
    sourceAgent: source,
    targetAgent: target,
    payload,
    traceKey: runId,
    stage,
  });
  await logPhase(
    runId,
    phaseId,
    result.passed ? "success" : "warn",
    `Guardrail ${result.score}/100 · ${source.name} → ${target.name}${result.passed ? " passed" : " needs correction"}.`,
    result.checks
      .map((check) => `[${check.level}] ${check.label}: ${check.detail} (${check.score} pts)`)
      .join("\n"),
  );
  runEvents.publish(runId, { type: "guardrail", runId, result });
  if (result.deadLoop.detected) {
    await learnFromFailure({
      agent: source,
      source: "dead-loop",
      detail: result.deadLoop.message,
      verdict: result,
    });
    runEvents.publish(runId, { type: "dead_loop", runId, deadLoop: result.deadLoop });
    throw new DeadLoopException(result.deadLoop);
  }
  if (!result.passed) {
    await learnFromFailure({
      agent: source,
      source: "guardrail",
      detail: result.errors.join(" ") || "Handoff did not meet the quality threshold.",
      verdict: result,
    });
  }
  return result;
}

export async function setPhase(
  runId: string,
  phaseId: PhaseId,
  patch: Partial<Run["phases"][number]>,
) {
  const run = await updateRun(runId, (run) => {
    const phase = run.phases.find((item) => item.id === phaseId);
    if (!phase) return;
    Object.assign(phase, patch);
  });
  if (run) {
    const phase = run.phases.find((item) => item.id === phaseId);
    if (phase) runEvents.publish(runId, { type: "phase", runId, phase });
    runEvents.publish(runId, {
      type: "status",
      runId,
      status: run.status,
      currentPhase: run.currentPhase,
    });
  }
  return run;
}

export async function beginPhase(runId: string, phaseId: PhaseId, agentId?: string) {
  await updateRun(runId, (run) => {
    run.status = "running";
    run.currentPhase = phaseId;
    const phase = run.phases.find((item) => item.id === phaseId);
    if (phase) {
      phase.status = "running";
      phase.startedAt = Date.now();
      phase.progress = 5;
      phase.agentId = agentId;
    }
  });
  await publishSnapshot(runId);
}

export async function finishPhase(
  runId: string,
  phaseId: PhaseId,
  status: "passed" | "failed" | "skipped",
  error?: string,
) {
  await setPhase(runId, phaseId, {
    status,
    progress: status === "passed" ? 100 : 100,
    completedAt: Date.now(),
    error,
  });
}

export async function addArtifact(runId: string, artifact: string) {
  await updateRun(runId, (run) => {
    if (!run.artifacts.fileTree.includes(artifact)) run.artifacts.fileTree.push(artifact);
  });
}

export function publishArtifactEvent(
  source: string,
  runId: string,
  projectId: string,
  files: Array<{ path: string; content: string }>,
  title: string,
) {
  if (!files.length) return;
  meshBus.publish({
    type: "ARTIFACT_CREATED",
    source,
    runId,
    projectId,
    severity: "info",
    title,
    message: files.map((file) => file.path).slice(0, 12).join(", "),
    payload: {
      files: files.slice(0, 18).map((file) => ({
        path: file.path,
        content: file.content,
      })),
    },
  });
}

export function assertActive(runId: string) {
  const active = activeRuns.get(runId);
  if (active?.cancelled) throw new DOMException("Run cancelled", "AbortError");
}

