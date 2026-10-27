import type { Agent, CommandResult, Project } from "../types";
import type { TaskContract } from "../mesh/accountability";
import { acceptTask, createTaskContract } from "../mesh/accountability";
import { inferResolutionPath, meshBus } from "../mesh/event-bus";
import type { RuntimeValidationResult } from "../mesh/validators";

export const MAX_SELF_HEAL_ATTEMPTS = 3;

export interface RepairAttemptRecord {
  attempt: number;
  maxAttempts: number;
  contract: TaskContract;
  appliedFiles: string[];
  passed: boolean;
  detail?: string;
  durationMs: number;
}

export interface RepairCycleResult {
  passed: boolean;
  attempts: RepairAttemptRecord[];
  runtime: RuntimeValidationResult;
  exhausted: boolean;
}

export interface RepairContract {
  contract: TaskContract;
  failureLog: string;
  resolutionPath: string;
  failedCommands: CommandResult[];
}

export interface RepairCycleOptions {
  project: Pick<Project, "id" | "name" | "workspacePath">;
  agent: Agent;
  runId?: string;
  initial: RuntimeValidationResult;
  maxAttempts?: number;
  repair: (
    contract: TaskContract,
    attempt: number,
    failure: RuntimeValidationResult,
  ) => Promise<{ appliedFiles: string[]; detail?: string }>;
  verify: () => Promise<RuntimeValidationResult>;
  onAttempt?: (event: {
    phase: "start" | "complete";
    attempt: number;
    maxAttempts: number;
    contract: TaskContract;
    failure: RuntimeValidationResult;
    record?: RepairAttemptRecord;
  }) => void | Promise<void>;
}

function failedCommands(runtime: RuntimeValidationResult): CommandResult[] {
  return runtime.results.filter((result) => result.exitCode !== 0 || result.timedOut);
}

export function formatFailureLog(runtime: RuntimeValidationResult): string {
  const failures = failedCommands(runtime);
  if (!failures.length) return runtime.detail.slice(-12_000);
  return failures
    .map((result) => {
      const output = result.stderr || result.stdout || "(no output captured)";
      return `$ ${result.command}\nexit: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${output}`;
    })
    .join("\n\n")
    .slice(-12_000);
}

/**
 * Convert a terminal/build failure into an explicit, high-priority repair
 * contract addressed to the responsible developer agent.
 */
export function createRepairContract(input: {
  project: Pick<Project, "id" | "name">;
  agent: Pick<Agent, "id" | "name" | "handle">;
  runtime: RuntimeValidationResult;
  attempt: number;
  maxAttempts: number;
}): RepairContract {
  const failureLog = formatFailureLog(input.runtime);
  const resolutionPath = inferResolutionPath(failureLog);
  const failed = failedCommands(input.runtime);
  const contract = createTaskContract({
    sourceAgent: "Runtime QA Validator",
    targetAgent: input.agent.name,
    objective: [
      `SELF-HEALING REPAIR CONTRACT ${input.attempt}/${input.maxAttempts} for ${input.project.name}.`,
      `Repair the failing runtime verification without changing the product scope.`,
      `Failed command(s): ${failed.map((result) => result.command).join(", ") || "runtime verification"}.`,
      `Resolution path: ${resolutionPath}`,
      "Return only the minimal complete files required to make the failing command pass.",
    ].join("\n"),
    requiredArtifacts: [],
    requiredCapabilities: [],
    maxTokenBudget: 4_096,
  });
  return {
    contract: acceptTask(contract, input.agent as Agent, { publish: false }),
    failureLog,
    resolutionPath,
    failedCommands: failed,
  };
}

/**
 * Run up to three automatic repair iterations. The task contract is never
 * marked BLOCKED here; the caller only blocks the parent task after this cycle
 * exhausts its attempts without a passing runtime proof.
 */
export async function runRepairCycle(options: RepairCycleOptions): Promise<RepairCycleResult> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? MAX_SELF_HEAL_ATTEMPTS, MAX_SELF_HEAL_ATTEMPTS));
  const attempts: RepairAttemptRecord[] = [];
  let runtime = options.initial;

  if (runtime.passed) {
    return { passed: true, attempts, runtime, exhausted: false };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const repair = createRepairContract({
      project: options.project,
      agent: options.agent,
      runtime,
      attempt,
      maxAttempts,
    });

    meshBus.publish({
      type: "TASK_CONTRACT",
      source: "Self-Healing Repair Engine",
      target: `@${options.agent.handle.replace(/^@/, "")}`,
      agentId: options.agent.id,
      targetAgentId: options.agent.id,
      projectId: options.project.id,
      runId: options.runId,
      severity: "warning",
      title: `Self-healing repair ${attempt}/${maxAttempts} routed to @${options.agent.handle.replace(/^@/, "")}`,
      message: `${repair.failureLog}\n\nresolutionPath: ${repair.resolutionPath}`,
      payload: {
        contract: repair.contract,
        repair: true,
        priority: "high",
        attempt,
        maxAttempts,
        failedCommands: repair.failedCommands.map((result) => result.command),
        failureLog: repair.failureLog,
        resolutionPath: repair.resolutionPath,
      },
    });

    await options.onAttempt?.({
      phase: "start",
      attempt,
      maxAttempts,
      contract: repair.contract,
      failure: runtime,
    });

    let appliedFiles: string[] = [];
    let detail: string | undefined;
    try {
      const outcome = await options.repair(repair.contract, attempt, runtime);
      appliedFiles = outcome.appliedFiles;
      detail = outcome.detail;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }

    runtime = await options.verify();
    const record: RepairAttemptRecord = {
      attempt,
      maxAttempts,
      contract: repair.contract,
      appliedFiles,
      passed: runtime.passed,
      detail,
      durationMs: Date.now() - startedAt,
    };
    attempts.push(record);
    await options.onAttempt?.({
      phase: "complete",
      attempt,
      maxAttempts,
      contract: repair.contract,
      failure: runtime,
      record,
    });

    if (runtime.passed) {
      return { passed: true, attempts, runtime, exhausted: false };
    }
  }

  return {
    passed: false,
    attempts,
    runtime,
    exhausted: true,
  };
}
