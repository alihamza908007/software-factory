import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getAgent,
  getProject,
  getRun,
  getSettings,
  listAgents,
  saveProject,
  saveRun,
  updateRun,
} from "../db";
import { createPhases, PHASES } from "../constants";
import { runEvents } from "../events";
import { generateWithAgent } from "../providers/router";
import {
  correctiveInstruction,
  DeadLoopException,
  validateAgentHandoff,
} from "./guardrails";
import type {
  Agent,
  GuardrailResult,
  HealAttempt,
  PhaseId,
  Project,
  Run,
  RunStatus,
} from "../types";
import { slugify, truncate, uid } from "../utils";
import {
  inspectWorkspaceHandshake,
  listWorkspaceFiles,
  preserveDuplicateRouteFiles,
  readWorkspaceContext,
  scaffoldProject,
  treeSummary,
  writeProjectFile,
} from "../workspace";
import {
  applyFileBlocks,
  parseFileBlocks,
  summarizeFiles,
  type ParsedFile,
} from "./parse";
import {
  architecturePrompt,
  dependencyHandshakeRepairPrompt,
  deployPrompt,
  healPrompt,
  implementationPrompt,
  specPrompt,
  testPrompt,
} from "./prompts";
import { branchNameFor, commitAll, ensureRunBranch, initRepo, readGitState, pushBranch } from "../tools/git";
import {
  createPullRequest,
  buildPullRequestBody,
  ensureGitHubRepo,
} from "../tools/github";
import {
  detectStack,
  failureDigest,
  formatCommandResults,
  resultsFailed,
  runBuild,
  runInstallIfNeeded,
  runLint,
  runTests,
} from "../tools/toolchain";
import { buildWorkflow, verifyWorkflow } from "../tools/workflow";
import { learnFromFailure } from "../mesh/agent-memory";
import { inferResolutionPath, meshBus, publishAgentEnvelope, setMeshAgentStatus } from "../mesh/event-bus";
import { ensureValidatorRuntime, verifyPostFlight, verifyProjectRuntime } from "../mesh/validators";
import { decomposeProjectTask, type DecomposedTask } from "./decomposer";
import { negotiateTaskOwnership } from "../mesh/negotiation";
import { acceptTask, completeTaskContract, createTaskContract, inferRequiredCapabilities } from "../mesh/accountability";
import { executeCanvasTopology, executeDag } from "./scheduler";
import { runRepairCycle } from "./repair-engine";

type ActiveRun = { controller: AbortController; cancelled: boolean };
const globalStore = globalThis as typeof globalThis & {
  __factoryActiveRuns?: Map<string, ActiveRun>;
};
const activeRuns = (globalStore.__factoryActiveRuns ??= new Map<string, ActiveRun>());

function phaseMeta(id: PhaseId) {
  return PHASES.find((phase) => phase.id === id)!;
}

function findAgent(agents: Agent[], patterns: RegExp[], fallbackHandle?: string): Agent | undefined {
  return (
    agents.find((agent) => agent.enabled && patterns.some((pattern) => pattern.test(agent.role))) ??
    (fallbackHandle ? agents.find((agent) => agent.handle === fallbackHandle) : undefined) ??
    agents.find((agent) => agent.enabled)
  );
}

function resolveAgents(agents: Agent[]): Record<PhaseId, Agent | undefined> {
  return {
    requirements: findAgent(agents, [/product/i, /manager/i], "product"),
    architecture: findAgent(agents, [/architect/i, /systems/i], "architect"),
    implementation: findAgent(agents, [/developer/i, /engineer/i, /full.?stack/i], "developer"),
    testing: findAgent(agents, [/qa/i, /test/i, /quality/i], "qa"),
    deployment: findAgent(agents, [/devops/i, /deploy/i, /platform/i, /sre/i], "devops"),
  };
}

async function publishSnapshot(runId: string) {
  const run = await getRun(runId);
  if (run) runEvents.publish(runId, { type: "snapshot", run });
}

async function logPhase(
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

async function guardHandoff(
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

async function setPhase(
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

async function beginPhase(runId: string, phaseId: PhaseId, agentId?: string) {
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

async function finishPhase(
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

async function addArtifact(runId: string, artifact: string) {
  await updateRun(runId, (run) => {
    if (!run.artifacts.fileTree.includes(artifact)) run.artifacts.fileTree.push(artifact);
  });
}

function publishArtifactEvent(
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

function assertActive(runId: string) {
  const active = activeRuns.get(runId);
  if (active?.cancelled) throw new DOMException("Run cancelled", "AbortError");
}

async function applyNodeManifest(root: string) {
  const pkgPath = path.join(root, "package.json");
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    pkg = { name: "factory-project", version: "0.1.0", private: true };
  }
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  if (!scripts.test) scripts.test = "node --test test/*.test.js";
  if (!scripts.start) scripts.start = "node src/index.js";
  pkg.scripts = scripts;
  const jsFiles = (await listWorkspaceFiles(root, 200)).filter((file) =>
    /\.(js|mjs)$/.test(file),
  );
  let usesEsm = false;
  for (const file of jsFiles.slice(0, 40)) {
    try {
      const content = await fs.readFile(path.join(root, file), "utf8");
      if (/^\s*(import|export)\s/m.test(content)) {
        usesEsm = true;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (usesEsm && !pkg.type) pkg.type = "module";
  await writeProjectFile(root, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
}

function normalizeTestFiles(files: ParsedFile[], stack: Project["stack"]): ParsedFile[] {
  return files.map((file) => {
    const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file.path) || /^tests?\//.test(file.path);
    if (!isTest) return file;
    if (stack === "python") {
      if (file.path.startsWith("tests/")) return file;
      return { ...file, path: `tests/test_${path.basename(file.path)}` };
    }
    if (file.path.startsWith("test/")) return file;
    const basename = path.basename(file.path).replace(/\.(spec)\./, ".test.");
    return { ...file, path: `test/${basename}` };
  });
}

async function commitPhase(
  runId: string,
  root: string,
  message: string,
  phaseId: PhaseId,
) {
  const settings = await getSettings();
  if (!settings.autoCommit) {
    await logPhase(runId, phaseId, "info", "Auto-commit disabled; changes left in workspace.");
    return;
  }
  const result = await commitAll(root, message);
  if (result.committed) {
    await logPhase(
      runId,
      phaseId,
      "success",
      `Committed ${result.hash ?? ""} · ${message}`,
    );
    const state = await readGitState(root);
    await updateRun(runId, (run) => {
      run.git = { ...run.git, ...state, pushed: false };
    });
  } else {
    await logPhase(runId, phaseId, "info", `Nothing to commit for "${message}".`);
  }
}

async function runVerification(
  runId: string,
  root: string,
  stack: Project["stack"],
  phaseId: PhaseId,
  includeInstall = true,
  allowConcurrency = false,
) {
  const settings = await getSettings();
  if (!settings.allowExecution) {
    await logPhase(
      runId,
      phaseId,
      "warn",
      "Local command execution is disabled in Settings. Skipping install, lint, and tests — this run is in static-generation mode.",
    );
    return { results: [], failed: false };
  }
  if (includeInstall) {
    const install = await runInstallIfNeeded(root, stack, 300_000);
    for (const result of install) {
      await logPhase(
        runId,
        phaseId,
        "command",
        `$ ${result.command} · ${result.exitCode === 0 ? "ok" : "failed"}`,
        (result.stdout + result.stderr).slice(-2500),
      );
    }
  }
  await logPhase(
    runId,
    phaseId,
    "command",
    allowConcurrency
      ? "Running syntax / lint checks and tests concurrently…"
      : "Running syntax / lint checks…",
  );
  const [lint, tests] = allowConcurrency
    ? await Promise.all([runLint(root, stack), runTests(root, stack)])
    : [await runLint(root, stack), [] as Awaited<ReturnType<typeof runTests>>];
  for (const result of lint.slice(-12)) {
    await logPhase(
      runId,
      phaseId,
      result.exitCode === 0 ? "info" : "error",
      `$ ${result.command} · exit ${result.exitCode}`,
      (result.stdout + result.stderr).slice(-1600) || undefined,
    );
  }
  if (!allowConcurrency) {
    await logPhase(runId, phaseId, "command", "Running test suite…");
    tests.push(...(await runTests(root, stack)));
  }
  for (const result of tests) {
    await logPhase(
      runId,
      phaseId,
      result.exitCode === 0 ? "success" : "error",
      `$ ${result.command} · exit ${result.exitCode}`,
      (result.stdout + result.stderr).slice(-6000) || undefined,
    );
  }
  const results = [...lint, ...tests];
  const failed = resultsFailed(results);
  if (failed) {
    const fileTree = await listWorkspaceFiles(root, 160);
    const output = failureDigest(results, 12_000);
    const resolutionPath = inferResolutionPath(output);
    meshBus.publish({
      type: "TEST_FAILED",
      source: "Local toolchain",
      runId,
      severity: "error",
      title: "Verification failure observed",
      message: "The local lint/test toolchain returned a non-zero result. Silent Witness is inspecting the failure.",
      payload: { output, resolutionPath, fileTree, workspaceRoot: root },
      requiresOverride: false,
    });
    const developer = (await listAgents()).find((agent) => agent.enabled && /developer|implementation/i.test(`${agent.handle} ${agent.role}`));
    publishAgentEnvelope({
      from: "@local-toolchain",
      to: developer ? `@${developer.handle.replace(/^@/, "")}` : "@developer",
      type: "VALIDATION_REPORT",
      payload: output.slice(-4_000),
      timestamp: new Date().toISOString(),
      resolutionPath,
      fileTree,
      workspaceRoot: root,
      status: "FAILED",
    }, { agentId: developer?.id, targetAgentId: developer?.id, runId });
  }
  return { results, failed };
}

async function generateFiles(
  runId: string,
  phaseId: PhaseId,
  agent: Agent,
  project: Project,
  root: string,
  messages: Parameters<typeof generateWithAgent>[0]["messages"],
  purpose: string,
  options?: { testFiles?: boolean; guardrailTarget?: Agent; guardrailStage?: string; signal?: AbortSignal },
): Promise<{ files: ParsedFile[]; raw: string; outcome: Awaited<ReturnType<typeof generateWithAgent>> }> {
  const settings = await getSettings();
  await logPhase(runId, phaseId, "agent", `${agent.name} (${agent.role}) is generating…`);
  setMeshAgentStatus(agent.id, "thinking", `${phaseId} · preparing generation`);
  meshBus.publish({
    type: "AGENT_STATUS",
    source: agent.name,
    agentId: agent.id,
    runId,
    severity: "info",
    title: `${agent.name} is thinking`,
    message: `${phaseId} phase · ${purpose}`,
    payload: { status: "thinking", detail: purpose },
  });
  let outcome: Awaited<ReturnType<typeof generateWithAgent>>;
  try {
    setMeshAgentStatus(agent.id, "executing", `${phaseId} · ${purpose}`);
    outcome = await generateWithAgent({
      agent,
      messages,
      purpose,
      runId,
      projectDir: root,
      priority: phaseId === "implementation" ? 9 : phaseId === "testing" ? 8 : 6,
      signal: options?.signal,
      onStatus: (status) => {
        void logPhase(runId, phaseId, status.stage === "fallback" ? "warn" : "info", status.message);
      },
    });
  } catch (error) {
    setMeshAgentStatus(agent.id, "error", String(error).slice(0, 200));
    await learnFromFailure({
      agent,
      source: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  setMeshAgentStatus(agent.id, "idle", `${phaseId} generation complete`);
  await logPhase(
    runId,
    phaseId,
    "success",
    `${agent.name} completed · ${outcome.result.outputTokens} tok · ${outcome.result.tokensPerSec.toFixed(
      1,
    )} tok/s · TTFT ${Math.round(outcome.result.ttftMs)}ms`,
  );

  let verdict: GuardrailResult | undefined;
  if (options?.guardrailTarget) {
    verdict = await guardHandoff(
      runId,
      phaseId,
      agent,
      options.guardrailTarget,
      outcome.result.text,
      options.guardrailStage ?? purpose,
    );
    let retry = 0;
    while (!verdict.passed && retry < settings.guardrailMaxRetries) {
      retry += 1;
      await logPhase(
        runId,
        phaseId,
        "warn",
        `Guardrail corrective retry ${retry}/${settings.guardrailMaxRetries} for ${agent.name}.`,
        correctiveInstruction(verdict),
      );
      outcome = await generateWithAgent({
        agent,
        messages: [
          ...messages,
          { role: "user", content: correctiveInstruction(verdict) },
        ],
        purpose: `${purpose} · guardrail repair ${retry}`,
        runId,
        projectDir: root,
        priority: phaseId === "implementation" ? 9 : 8,
        onStatus: (status) => {
          void logPhase(runId, phaseId, status.stage === "fallback" ? "warn" : "info", status.message);
        },
      });
      verdict = await guardHandoff(
        runId,
        phaseId,
        agent,
        options.guardrailTarget,
        outcome.result.text,
        options.guardrailStage ?? purpose,
      );
    }
  }

  let files = parseFileBlocks(outcome.result.text);
  if (options?.testFiles && files.length) {
    files = normalizeTestFiles(files, project.stack);
  }
  return { files, raw: outcome.result.text, outcome };
}

async function performDependencyHandshake(
  runId: string,
  project: Project,
  root: string,
  agent: Agent,
  signal?: AbortSignal,
) {
  let handshake = await inspectWorkspaceHandshake(root, project.stack);
  const preserved: string[] = [];
  for (const finding of handshake.findings) {
    const moved = await preserveDuplicateRouteFiles(root, finding).catch(() => []);
    preserved.push(...moved);
  }
  if (preserved.length) {
    handshake = await inspectWorkspaceHandshake(root, project.stack);
    const resolutionPath = `Duplicate route source(s) preserved under .factory/preflight-backups; the higher-priority TypeScript route remains active. Verify the selected route and run npm run build.`;
    await logPhase(runId, "implementation", "warn", "Dependency handshake preserved duplicate route files before build.", preserved.join("\n"));
    publishAgentEnvelope({
      from: "@workspace-preflight",
      to: `@${agent.handle.replace(/^@/, "")}`,
      type: "VALIDATION_REPORT",
      payload: `The route conflict was removed from Next.js routing while the duplicate source was preserved for recovery. ${preserved.join("; ")}`,
      timestamp: new Date().toISOString(),
      resolutionPath,
      fileTree: handshake.fileTree,
      workspaceRoot: handshake.workspaceRoot,
      status: "INFO",
    }, { agentId: agent.id, runId, projectId: project.id });
  }

  for (const finding of handshake.findings.filter((item) => item.severity === "warning")) {
    await logPhase(runId, "implementation", "warn", `Dependency handshake · ${finding.code}`, `${finding.detail}\nresolutionPath: ${finding.resolutionPath}`);
  }
  let attempt = 0;
  while (handshake.blocked && attempt < 3) {
    assertActive(runId);
    attempt += 1;
    const blocker = handshake.findings.find((finding) => finding.severity === "error");
    if (!blocker) break;
    await logPhase(runId, "implementation", "error", `Dependency handshake blocked · ${blocker.code} · repair ${attempt}/3`, `${blocker.detail}\nresolutionPath: ${blocker.resolutionPath}`);
    meshBus.publish({
      type: "VALIDATION_FAILED",
      source: "Workspace dependency handshake",
      agentId: agent.id,
      projectId: project.id,
      runId,
      severity: "error",
      title: `Pre-flight blocked · ${blocker.code}`,
      message: blocker.detail,
      payload: { resolutionPath: blocker.resolutionPath, fileTree: handshake.fileTree, workspaceRoot: handshake.workspaceRoot, finding: blocker },
      requiresOverride: false,
    });
    publishAgentEnvelope({
      from: "@workspace-preflight",
      to: `@${agent.handle.replace(/^@/, "")}`,
      type: "VALIDATION_REPORT",
      payload: blocker.detail,
      timestamp: new Date().toISOString(),
      resolutionPath: blocker.resolutionPath,
      fileTree: handshake.fileTree,
      workspaceRoot: handshake.workspaceRoot,
      status: "BLOCKED",
    }, { agentId: agent.id, targetAgentId: agent.id, runId, projectId: project.id });

    const repair = await generateFiles(
      runId,
      "implementation",
      agent,
      project,
      root,
      dependencyHandshakeRepairPrompt(agent, project, handshake),
      `dependency handshake repair ${attempt}`,
      { signal },
    );
    const applied = repair.files.length ? await applyFileBlocks(root, repair.files) : { written: [], errors: [] };
    if (!applied.written.length) break;
    handshake = await inspectWorkspaceHandshake(root, project.stack);
    for (const finding of handshake.findings) {
      const moved = await preserveDuplicateRouteFiles(root, finding).catch(() => []);
      preserved.push(...moved);
    }
    if (preserved.length) handshake = await inspectWorkspaceHandshake(root, project.stack);
  }
  if (handshake.blocked) {
    const blocker = handshake.findings.find((finding) => finding.severity === "error");
    const resolutionPath = blocker?.resolutionPath ?? "Resolve the workspace dependency handshake findings, then rerun the build.";
    throw new Error(`Workspace pre-flight remains blocked after ${attempt} repair attempt(s). ${blocker?.detail ?? "Unknown structural conflict."}\nresolutionPath: ${resolutionPath}\nworkspaceRoot: ${handshake.workspaceRoot}\nfileTree:\n${handshake.fileTree.map((file) => `${handshake.workspaceRoot}/${file}`).join("\n")}`);
  }
  return handshake;
}

async function processImplementation(
  runId: string,
  project: Project,
  root: string,
  agents: Record<PhaseId, Agent | undefined>,
  spec: string,
  architecture: string,
  allowConcurrency = false,
  signal?: AbortSignal,
  taskPlan: DecomposedTask[] = [],
) {
  const developer = agents.implementation;
  if (!developer) throw new Error("No developer agent is configured.");
  let handshake = await performDependencyHandshake(runId, project, root, developer, signal);
  let tree = await treeSummary(root);
  let prompt = implementationPrompt(developer, project, project.description, spec, architecture, tree, handshake);
  const qa = agents.testing;
  const implementationCapabilities = inferRequiredCapabilities(`${spec}\n${architecture}`)
    .filter((capability) => capability === "frontend/ui/react" || capability === "backend/api/data");
  let implementationContract = acceptTask(createTaskContract({
    sourceAgent: agents.architecture?.name ?? "Architecture",
    targetAgent: developer.name,
    objective: `Implement ${project.name} to satisfy the approved specification and architecture.`,
    requiredArtifacts: [],
    requiredCapabilities: implementationCapabilities,
    maxTokenBudget: Math.min(8_192, developer.maxTokens),
  }), developer, {
    workspaceRoot: root,
    fileTree: handshake.fileTree,
    projectId: project.id,
    runId,
  });
  if (implementationContract.status !== "ACCEPTED") {
    throw new Error(`${developer.name} failed the implementation pre-flight: ${implementationContract.reason ?? "readiness check failed"}${implementationContract.preflight?.resolutionPath ? `\nresolutionPath: ${implementationContract.preflight.resolutionPath}` : ""}`);
  }
  await logPhase(runId, "implementation", "success", `Implementation pre-flight passed for ${developer.name}.`, implementationContract.preflight?.reason);
  let redTestOutput = "";
  if (qa) {
    await logPhase(runId, "implementation", "info", "TDD preflight: asking QA to write verification files before implementation.");
    const preflight = await generateFiles(
      runId,
      "implementation",
      qa,
      project,
      root,
      testPrompt(qa, project, project.description, spec, architecture, tree, await readWorkspaceContext(root, 12_000)),
      "TDD verification authoring",
      { testFiles: true, guardrailTarget: developer, guardrailStage: "TDD preflight", signal },
    );
    if (preflight.files.length) {
      const appliedTests = await applyFileBlocks(root, preflight.files);
      if (appliedTests.written.length) {
        await logPhase(runId, "implementation", "success", `QA staged ${appliedTests.written.length} verification file(s) before implementation.`, summarizeFiles(preflight.files));
        if (project.stack !== "python") await applyNodeManifest(root);
        if ((await getSettings()).allowExecution) {
          const red = await runTests(root, project.stack);
          redTestOutput = formatCommandResults(red).slice(-7_000);
          await logPhase(runId, "implementation", "command", "TDD red phase · pre-implementation test execution", redTestOutput || "No test output.");
        }
      }
    } else {
      await logPhase(runId, "implementation", "warn", "QA did not return executable test files in the TDD preflight.", truncate(preflight.raw, 1_200));
    }
    tree = await treeSummary(root);
    handshake = await performDependencyHandshake(runId, project, root, developer, signal);
    tree = await treeSummary(root);
    prompt = implementationPrompt(developer, project, project.description, spec, architecture, tree, handshake);
    if (redTestOutput) prompt = [...prompt, { role: "user", content: `PRE-IMPLEMENTATION TEST OUTPUT (expected failures before code; make these pass):\n${redTestOutput}` }];
  }
  const splitCandidate = allowConcurrency &&
    /front.?end|user interface|\bui\b|client-side/i.test(`${spec}\n${architecture}`) &&
    /back.?end|\bapi\b|database|schema/i.test(`${spec}\n${architecture}`);
  let generated: Awaited<ReturnType<typeof generateFiles>> | undefined;
  if (splitCandidate) {
    const workforce = (await listAgents()).filter((agent) => agent.enabled);
    const plannedAgent = (track: string) => {
      const handle = taskPlan.find((task) => task.track === "implementation" && task.id.includes(track))?.targetAgent;
      return workforce.find((agent) => `@${agent.handle.replace(/^@/, "")}` === handle);
    };
    const frontend = plannedAgent("ui") ?? workforce.find((agent) => /front.?end|ui|web/i.test(`${agent.name} ${agent.role}`)) ?? developer;
    const backend = plannedAgent("api") ?? workforce.find((agent) => agent.id !== frontend.id && /back.?end|api|data|database/i.test(`${agent.name} ${agent.role}`)) ?? developer;
    const track = (agent: Agent, label: string, scope: string) => ({
      id: label,
      label,
      kind: "agent" as const,
      dependsOn: [],
      run: () => generateFiles(
        runId,
        "implementation",
        agent,
        project,
        root,
        [
          ...prompt,
          { role: "user" as const, content: `Implement only the ${label} track. ${scope} Coordinate through the architecture contract; do not create or modify files outside your owned paths. Return complete files using path= annotations.` },
        ],
        `implementation · ${label} track`,
        { guardrailTarget: agents.testing, guardrailStage: `implementation ${label}`, signal },
      ),
    });
    await logPhase(runId, "implementation", "info", "Specification contains separable UI and API work; scheduling two implementation tracks.");
    const graph = await executeDag([
      track(frontend, "frontend", "Own UI components, client pages and styles."),
      track(backend, "backend", "Own API routes, server logic, persistence and schemas."),
    ], {
      signal,
      emit: (event) => {
        if (event.type === "start" || event.type === "complete" || event.type === "failed") {
          void logPhase(runId, "implementation", event.type === "failed" ? "warn" : "info", `Parallel ${event.label} track ${event.type}.`);
        }
      },
    });
    const tracks = Object.values(graph.outputs).filter((value): value is Awaited<ReturnType<typeof generateFiles>> => Boolean(value));
    const merged = new Map<string, ParsedFile>();
    let conflict = false;
    for (const result of tracks) {
      for (const file of result.files) {
        const existing = merged.get(file.path);
        if (existing && existing.content !== file.content) conflict = true;
        else merged.set(file.path, file);
      }
    }
    if (graph.ok && !conflict && tracks.length === 2 && merged.size) {
      generated = {
        files: Array.from(merged.values()),
        raw: tracks.map((result) => result.raw).join("\n\n"),
        outcome: tracks[0].outcome,
      };
    } else {
      await logPhase(runId, "implementation", "warn", conflict
        ? "Parallel tracks claimed the same path with different content; retrying as one coordinated implementation."
        : "Parallel tracks did not return usable files; retrying as one coordinated implementation.");
    }
  }
  generated ??= await generateFiles(
    runId,
    "implementation",
    developer,
    project,
    root,
    prompt,
    "implementation",
    {
      guardrailTarget: agents.testing,
      guardrailStage: "implementation",
      signal,
    },
  );

  if (!generated.files.length) {
    await logPhase(
      runId,
      "implementation",
      "warn",
      "No file blocks detected in the first implementation response. Requesting a format-corrected retry.",
    );
    generated = await generateFiles(
      runId,
      "implementation",
      developer,
      project,
      root,
      [
        ...prompt,
        {
          role: "user",
          content:
            "Your previous response did not contain parseable file blocks. Re-emit the complete implementation using only fenced blocks whose info string is `lang path=relative/path.ext`.",
        },
      ],
      "implementation retry",
      {
        guardrailTarget: agents.testing,
        guardrailStage: "implementation",
        signal,
      },
    );
  }

  if (!generated.files.length) {
    await writeProjectFile(root, "docs/IMPLEMENTATION_RAW.md", generated.raw);
    throw new Error(
      "The developer agent returned no parseable files. Raw output saved to docs/IMPLEMENTATION_RAW.md.",
    );
  }

  const applied = await applyFileBlocks(root, generated.files);
  if (applied.errors.length) {
    await logPhase(
      runId,
      "implementation",
      "warn",
      `${applied.errors.length} file(s) were blocked or failed to write.`,
      applied.errors.map((error) => `${error.path}: ${error.error}`).join("\n"),
    );
  }
  if (!applied.written.length) {
    throw new Error("No implementation files could be written to the workspace.");
  }
  if (project.stack === "node" || project.stack === "next") await applyNodeManifest(root);

  const contract = {
    ...implementationContract,
    requiredArtifacts: applied.written,
    maxTokenBudget: Math.min(8_192, developer.maxTokens),
  };
  const acceptedContract = { ...contract, status: "ACCEPTED" as const, reason: "Implementation artifacts were written; post-flight and runtime proof are now required." };
  const onRuntimeOutput = ({ stream, text, command }: { stream: "stdout" | "stderr"; text: string; command: string }) => {
      const detail = text.slice(-1_200);
      meshBus.publish({
        type: "TERMINAL_OUTPUT",
        source: "Runtime QA",
        agentId: developer.id,
        projectId: project.id,
        runId,
        severity: stream === "stderr" ? "warning" : "info",
        title: command,
        message: detail,
        payload: { stream, command },
      });
      runEvents.publish(runId, {
        type: "log",
        runId,
        phaseId: "implementation",
        log: { id: uid("log"), at: Date.now(), level: stream === "stderr" ? "warn" : "command", message: `$ ${command} · ${stream}`, detail },
      });
  };
  let runtime = await verifyProjectRuntime({ projectId: project.id, agent: developer, runId, onOutput: onRuntimeOutput });
  const repairCycle = await runRepairCycle({
    project,
    agent: developer,
    runId,
    initial: runtime,
    maxAttempts: Math.min((await getSettings()).maxHealAttempts, 3),
    verify: () =>
      verifyProjectRuntime({ projectId: project.id, agent: developer, runId, onOutput: onRuntimeOutput }),
    onAttempt: async (event) => {
      if (event.phase === "start") {
        await logPhase(
          runId,
          "implementation",
          "warn",
          `Runtime proof failed; repair contract ${event.attempt}/${event.maxAttempts} routed to @${developer.handle.replace(/^@/, "")}.`,
          event.failure.detail.slice(-8_000),
        );
        return;
      }
      await logPhase(
        runId,
        "implementation",
        event.record?.passed ? "success" : "warn",
        event.record?.passed
          ? `Runtime repair ${event.attempt}/${event.maxAttempts} passed.`
          : `Runtime repair ${event.attempt}/${event.maxAttempts} did not produce a green runtime proof.`,
        event.record?.detail,
      );
    },
    repair: async (contract, attempt, failure) => {
      assertActive(runId);
      const repairTree = await listWorkspaceFiles(root, 160);
      const repairResolution = inferResolutionPath(failure.detail);
      const repairEvidence = [
        contract.objective,
        failure.detail,
        `\nresolutionPath: ${repairResolution}`,
        `workspaceRoot: ${root}`,
        `authoritative fileTree:\n${repairTree.map((file) => `${root}/${file}`).join("\n")}`,
      ].join("\n\n");
      const repair = await generateFiles(
        runId,
        "implementation",
        developer,
        project,
        root,
        healPrompt(developer, project, spec, repairEvidence, await readWorkspaceContext(root, 24_000), attempt),
        `runtime proof repair ${attempt}`,
        { guardrailTarget: qa, guardrailStage: "runtime proof repair", signal },
      );
      const repairFiles = repair.files.length ? await applyFileBlocks(root, repair.files) : { written: [], errors: [] };
      if (!repairFiles.written.length) {
        return { appliedFiles: [], detail: "The repair attempt produced no applicable files." };
      }
      await logPhase(runId, "implementation", "info", `Applied ${repairFiles.written.length} runtime repair file(s).`, summarizeFiles(repair.files));
      if (project.stack !== "python") await applyNodeManifest(root);
      return { appliedFiles: repairFiles.written, detail: repair.raw.slice(-2_000) };
    },
  });
  runtime = repairCycle.runtime;
  for (const result of runtime.results) {
    await logPhase(runId, "implementation", result.exitCode === 0 ? "success" : "error", `$ ${result.command} · exit ${result.exitCode}`, (result.stdout + result.stderr).slice(-6_000));
  }
  const validationTree = await listWorkspaceFiles(root, 160);
  const postFlight = await verifyPostFlight({
    contract: { ...acceptedContract, requiredArtifacts: applied.written },
    agent: developer,
    workspaceRoot: root,
    fileTree: validationTree,
    artifacts: generated.files.map((file) => ({ path: file.path, content: file.content })),
    projectId: project.id,
    runId,
  });
  const completedBase = completeTaskContract(acceptedContract, runtime.proof, postFlight);
  const completedContract = repairCycle.exhausted && !runtime.passed
    ? {
        ...completedBase,
        status: "BLOCKED" as const,
        reason: `Self-healing repair exhausted after ${repairCycle.attempts.length} attempt(s). Runtime proof is still red. ${runtime.detail.slice(-600)}`,
      }
    : completedBase;
  publishAgentEnvelope({
    from: qa?.handle ? `@${qa.handle.replace(/^@/, "")}` : "@runtime-qa",
    to: `@${developer.handle.replace(/^@/, "")}`,
    type: "VALIDATION_REPORT",
    payload: runtime.passed
      ? postFlight.passed
        ? postFlight.summary.summary
        : `Post-flight blocked: ${postFlight.resolutionPath ?? "artifact verification failed"}`
      : runtime.detail.slice(-4_000),
    timestamp: new Date().toISOString(),
    resolutionPath: runtime.passed
      ? postFlight.passed
        ? "No repair required; runtime proof and post-flight checks passed."
        : postFlight.resolutionPath ?? inferResolutionPath("Post-flight artifact verification failed.")
      : inferResolutionPath(runtime.detail),
    fileTree: validationTree,
    workspaceRoot: root,
    status: runtime.passed && postFlight.passed ? "COMPLETED" : "FAILED",
    summary: postFlight.summary,
  }, { agentId: qa?.id, targetAgentId: developer.id, projectId: project.id, runId });
  meshBus.publish({
    type: "TASK_CONTRACT",
    source: completedContract.sourceAgent,
    target: completedContract.targetAgent,
    agentId: developer.id,
    targetAgentId: developer.id,
    projectId: project.id,
    runId,
    severity: completedContract.status === "COMPLETED" ? "success" : "error",
    title: completedContract.status === "COMPLETED" ? "Implementation runtime proof passed" : "Implementation rejected: runtime proof missing or failed",
    message: completedContract.reason ?? runtime.detail,
    payload: { contract: completedContract },
  });
  if (completedContract.status !== "COMPLETED") {
    throw new Error(completedContract.reason ?? `Runtime verification failed.\n${runtime.detail}`);
  }
  await logPhase(
    runId,
    "implementation",
    "success",
    `Wrote ${applied.written.length} files.`,
    summarizeFiles(generated.files),
  );

  const files = await listWorkspaceFiles(root, 300);
  await updateRun(runId, (run) => {
    run.artifacts.fileTree = files;
  });
  const artifacts = generated.files.map((file) => file.path);
  publishArtifactEvent(
    developer.name,
    runId,
    project.id,
    generated.files.map((file) => ({ path: file.path, content: file.content })),
    `${developer.name} published ${generated.files.length} implementation file(s)`,
  );
  await setPhase(runId, "implementation", { artifacts, progress: 100 });
  await commitPhase(
    runId,
    root,
    `feat(${project.slug || "app"}): implement generated application`,
    "implementation",
  );
  return generated.files;
}

async function processTesting(
  runId: string,
  project: Project,
  root: string,
  agents: Record<PhaseId, Agent | undefined>,
  spec: string,
  architecture: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  allowConcurrency = false,
) {
  const qa = agents.testing;
  if (!qa) throw new Error("No QA agent is configured.");
  const tree = await treeSummary(root);
  const codeContext = await readWorkspaceContext(root, 34_000);

  await setPhase(runId, "testing", { progress: 12 });
  const testGen = await generateFiles(
    runId,
    "testing",
    qa,
    project,
    root,
    testPrompt(qa, project, project.description, spec, architecture, tree, codeContext),
    "test authoring",
    {
      testFiles: true,
      guardrailTarget: agents.implementation,
      guardrailStage: "testing",
    },
  );

  if (testGen.files.length) {
    const applied = await applyFileBlocks(root, testGen.files);
    await logPhase(
      runId,
      "testing",
      "success",
      `QA wrote ${applied.written.length} test file(s).`,
      summarizeFiles(testGen.files),
    );
    if (project.stack === "node" || project.stack === "next") await applyNodeManifest(root);
    const artifacts = testGen.files.map((file) => file.path);
    publishArtifactEvent(
      qa.name,
      runId,
      project.id,
      testGen.files.map((file) => ({ path: file.path, content: file.content })),
      `${qa.name} published ${testGen.files.length} test file(s)`,
    );
    await setPhase(runId, "testing", { artifacts });
    await commitPhase(
      runId,
      root,
      `test(${project.slug || "app"}): add agent-authored test suite`,
      "testing",
    );
  } else {
    await logPhase(
      runId,
      "testing",
      "warn",
      "QA returned no parseable test files. Falling back to existing workspace tests.",
      truncate(testGen.raw, 800),
    );
  }

  await setPhase(runId, "testing", { progress: 35 });
  let verification = await runVerification(runId, root, project.stack, "testing", true, allowConcurrency);
  await updateRun(runId, (run) => {
    const phase = run.phases.find((item) => item.id === "testing");
    if (phase) phase.commands = verification.results;
  });

  let attempt = 0;
  const healLimit = Math.min(settings.maxHealAttempts, 3);
  while (verification.failed && attempt < healLimit) {
    assertActive(runId);
    attempt += 1;
    await setPhase(runId, "testing", {
      progress: Math.min(90, 35 + attempt * 15),
    });
    await logPhase(
      runId,
      "testing",
      "warn",
      `Self-heal attempt ${attempt}/${healLimit} — dispatching failure logs to ${agents.implementation?.name ?? "developer"}.`,
    );
    const developer = agents.implementation ?? qa;
    const failure = failureDigest(verification.results, 11_000);
    const currentCode = await readWorkspaceContext(root, 34_000);
    const heal = await generateFiles(
      runId,
      "testing",
      developer,
      project,
      root,
      healPrompt(developer, project, spec, failure, currentCode, attempt),
      `self-heal ${attempt}`,
      {
        guardrailTarget: qa,
        guardrailStage: "testing",
      },
    );

    const applied = heal.files.length ? await applyFileBlocks(root, heal.files) : { written: [], errors: [] };
    await logPhase(
      runId,
      "testing",
      applied.written.length ? "success" : "error",
      applied.written.length
        ? `Applied ${applied.written.length} repaired file(s).`
        : "The developer returned no parseable repair files.",
      summarizeFiles(heal.files),
    );
    if (applied.written.length) {
      await commitPhase(
        runId,
        root,
        `fix(${project.slug || "app"}): self-heal attempt ${attempt}`,
        "testing",
      );
    }

    verification = await runVerification(runId, root, project.stack, "testing", true, allowConcurrency);
    await updateRun(runId, (run) => {
      const phase = run.phases.find((item) => item.id === "testing");
      if (phase) phase.commands = verification.results;
    });

    const healAttempt: HealAttempt = {
      attempt,
      agentId: developer.id,
      agentName: developer.name,
      modelKey: heal.outcome.model.key,
      failureSummary: truncate(failure, 1200),
      appliedFiles: applied.written,
      result: verification.failed ? "failed" : "passed",
      log: formatCommandResults(verification.results).slice(-5000),
      createdAt: Date.now(),
    };
    await updateRun(runId, (run) => {
      const phase = run.phases.find((item) => item.id === "testing");
      if (phase) phase.healAttempts.push(healAttempt);
    });
    runEvents.publish(runId, { type: "heal", runId, attempt: healAttempt });

    if (!verification.failed) {
      await logPhase(runId, "testing", "success", `Self-healing converged after ${attempt} attempt(s).`);
      break;
    }
    if (!applied.written.length) break;
  }

  if (verification.failed) {
    await finishPhase(
      runId,
      "testing",
      "failed",
      `Verification still failing after ${attempt} self-heal attempt(s).`,
    );
    throw new Error("Testing phase failed after exhausting the self-heal budget.");
  }
  await finishPhase(runId, "testing", "passed");
  return verification;
}

async function processDeployment(
  runId: string,
  project: Project,
  root: string,
  agents: Record<PhaseId, Agent | undefined>,
  settings: Awaited<ReturnType<typeof getSettings>>,
  testSummary: string,
) {
  const runtimeStack = await detectStack(root);
  const workflow = buildWorkflow({ ...project, stack: runtimeStack });
  await writeProjectFile(root, workflow.path, workflow.content);
  const verification = verifyWorkflow(workflow.content);
  await updateRun(runId, (run) => {
    run.artifacts.workflowPath = workflow.path;
  });
  await addArtifact(runId, workflow.path);
  publishArtifactEvent(
    agents.deployment?.name ?? "DevOps",
    runId,
    project.id,
    [{ path: workflow.path, content: workflow.content }],
    `Deployment workflow published to ${workflow.path}`,
  );
  await logPhase(
    runId,
    "deployment",
    verification.valid ? "success" : "warn",
    `Generated ${workflow.path} for the ${runtimeStack} stack.`,
    verification.issues.length ? verification.issues.join("\n") : undefined,
  );

  const build = settings.allowExecution ? await runBuild(root, runtimeStack) : [];
  if (!settings.allowExecution) {
    await logPhase(
      runId,
      "deployment",
      "warn",
      "Local command execution is disabled in Settings. Skipping the deployment build check.",
    );
  }
  for (const result of build) {
    await logPhase(
      runId,
      "deployment",
      result.exitCode === 0 ? "success" : "error",
      `$ ${result.command} · exit ${result.exitCode}`,
      (result.stdout + result.stderr).slice(-5000),
    );
  }

  const devops = agents.deployment;
  let deployNotes = `# Deployment\n\nGenerated by Software Factory.\n\n${testSummary}\n`;
  if (devops) {
    try {
      const outcome = await generateWithAgent({
        agent: devops,
        messages: deployPrompt(
          devops,
          project,
          project.description,
          `${testSummary}\nWorkflow: ${workflow.path}\nFiles: ${(await listWorkspaceFiles(root, 100)).length}`,
        ),
        purpose: "deployment notes",
        runId,
        projectDir: root,
        priority: 5,
      });
      deployNotes = outcome.result.text;
      await logPhase(runId, "deployment", "info", `${devops.name} drafted deployment notes.`);
    } catch (error) {
      await logPhase(
        runId,
        "deployment",
        "warn",
        `Deployment note generation failed; using deterministic fallback. ${String(error).slice(0, 200)}`,
      );
    }
  }
  await writeProjectFile(root, "docs/DEPLOYMENT.md", deployNotes);
  await addArtifact(runId, "docs/DEPLOYMENT.md");

  await commitPhase(
    runId,
    root,
    `ci(${project.slug || "app"}): add generated GitHub Actions pipeline`,
    "deployment",
  );

  const buildFailed = resultsFailed(build);
  if (buildFailed) {
    const output = failureDigest(build, 12_000);
    const fileTree = await listWorkspaceFiles(root, 160);
    const resolutionPath = inferResolutionPath(output);
    meshBus.publish({
      type: "TEST_FAILED",
      source: "Deployment build gate",
      agentId: agents.implementation?.id,
      projectId: project.id,
      runId,
      severity: "error",
      title: "Deployment build blocked",
      message: output.slice(-1_200),
      payload: { output, resolutionPath, fileTree, workspaceRoot: root },
    });
    if (agents.implementation) {
      publishAgentEnvelope({
        from: "@deployment-build-gate",
        to: `@${agents.implementation.handle.replace(/^@/, "")}`,
        type: "VALIDATION_REPORT",
        payload: output.slice(-4_000),
        timestamp: new Date().toISOString(),
        resolutionPath,
        fileTree,
        workspaceRoot: root,
        status: "FAILED",
      }, { agentId: agents.deployment?.id, targetAgentId: agents.implementation.id, runId, projectId: project.id });
    }
    await finishPhase(runId, "deployment", "failed", "Build verification failed.");
    throw new Error(`Deployment build verification failed.\nresolutionPath: ${resolutionPath}\n${output.slice(-4_000)}`);
  }

  if (settings.githubToken && settings.githubOwner && settings.githubRepo) {
    await logPhase(
      runId,
      "deployment",
      "info",
      `GitHub integration enabled for ${settings.githubOwner}/${settings.githubRepo}.`,
    );
    const repo = await ensureGitHubRepo();
    if (!repo.ok || !repo.config) {
      await logPhase(runId, "deployment", "error", repo.error ?? "GitHub repository check failed.");
      await updateRun(runId, (run) => {
        run.artifacts.pr = { status: "failed", error: repo.error };
      });
    } else {
      const branch = (await getRun(runId))?.git.branch;
      if (!branch) throw new Error("No feature branch is recorded for this run.");
      const push = await pushBranch(
        root,
        branch,
        repo.config.owner,
        repo.config.repo,
        repo.config.token,
      );
      await updateRun(runId, (run) => {
        run.git.pushed = push.pushed;
        run.git.remote = push.remote;
        run.git.pushError = push.error;
      });
      if (!push.pushed) {
        await logPhase(runId, "deployment", "error", "Git push failed.", push.error);
        await updateRun(runId, (run) => {
          run.artifacts.pr = { status: "failed", error: push.error };
        });
      } else {
        await logPhase(runId, "deployment", "success", `Pushed ${branch} to GitHub.`);
        const fullRun = await getRun(runId);
        if (fullRun) {
          const pr = await createPullRequest(repo.config, {
            title: `feat: ${truncate(project.description || project.name, 70)}`,
            head: branch,
            base: settings.githubBaseBranch || "main",
            body: buildPullRequestBody(fullRun, project, testSummary),
          });
          await updateRun(runId, (run) => {
            run.artifacts.pr = pr;
          });
          await logPhase(
            runId,
            "deployment",
            pr.status === "created" ? "success" : "error",
            pr.status === "created"
              ? `Pull request #${pr.number} ready: ${pr.url}`
              : `Pull request creation failed: ${pr.error}`,
            pr.url,
          );
        }
      }
    }
  } else {
    await updateRun(runId, (run) => {
      run.artifacts.pr = {
        status: "skipped",
        error: "GitHub token/owner/repo not configured. Branch and workflow remain local.",
      };
    });
    await logPhase(
      runId,
      "deployment",
      "info",
      "GitHub credentials not configured; branch and workflow stay local. Configure GitHub in Settings to enable push + PR.",
    );
  }

  const pr = (await getRun(runId))?.artifacts.pr;
  if (pr?.status === "failed") {
    await finishPhase(runId, "deployment", "failed", pr.error);
    throw new Error(`GitHub deployment failed: ${pr.error}`);
  }
  await finishPhase(runId, "deployment", "passed");
}

async function executeRun(runId: string, resumeFrom?: PhaseId) {
  ensureValidatorRuntime();
  const run = await getRun(runId);
  if (!run) return;
  const project = await getProject(run.projectId);
  if (!project) {
    await updateRun(runId, (item) => {
      item.status = "failed";
      item.error = "Project not found.";
    });
    return;
  }
  const settings = await getSettings();
  const agents = resolveAgents(await listAgents());
  const root = project.workspacePath;
  const resumePhase = resumeFrom ?? "requirements";
  const phaseStartIndex = ["requirements", "architecture", "implementation", "testing", "deployment"].indexOf(resumePhase);
  const controller = activeRuns.get(runId)?.controller ?? new AbortController();
  if (!activeRuns.has(runId)) activeRuns.set(runId, { controller, cancelled: false });

  try {
    const activeAgents = Array.from(new Map(
      Object.values(agents)
        .filter((agent): agent is Agent => Boolean(agent))
        .map((agent) => [agent.id, agent] as const),
    ).values());
    const negotiation = await negotiateTaskOwnership({
      objective: run.prompt,
      agents: activeAgents,
      projectId: run.projectId,
      runId,
      managerId: agents.requirements?.id,
    });
    if (negotiation.negotiated) {
      await logPhase(
        runId,
        "requirements",
        "info",
        `One-turn ownership negotiation persisted (${negotiation.id}).`,
        `${negotiation.agreement}\n\n${negotiation.transcript.map((message) => `${message.fromAgent}: ${message.content}`).join("\n")}`,
      );
    }
    const taskPlan = decomposeProjectTask(run.prompt, activeAgents);
    const plannedAgent = (id: string) => {
      const handle = taskPlan.find((task) => task.id === id)?.targetAgent;
      return Object.values(agents).find((agent) => agent && `@${agent.handle.replace(/^@/, "")}` === handle);
    };
    agents.requirements = plannedAgent("task-requirements") ?? agents.requirements;
    agents.architecture = plannedAgent("task-architecture") ?? agents.architecture;
    agents.implementation = plannedAgent("task-implementation") ?? agents.implementation;
    agents.testing = plannedAgent("task-validation") ?? agents.testing;
    await logPhase(runId, "requirements", "info", `Deterministic task decomposition created ${taskPlan.length} tasks.`, JSON.stringify(taskPlan, null, 2));
    await fs.mkdir(root, { recursive: true });
    const existing = await listWorkspaceFiles(root, 5);
    if (!existing.length) {
      const created = await scaffoldProject(root, project.stack, project.name);
      await logPhase(
        runId,
        "requirements",
        "info",
        `Scaffolded ${project.stack} workspace (${created.length} files).`,
      );
    }

    const git = await initRepo(root, project.name);
    const branch = branchNameFor(project.slug);
    const branches = await ensureRunBranch(root, branch);
    await updateRun(runId, (item) => {
      item.git = {
        ...git,
        branch: branches.branch,
        baseBranch: branches.baseBranch,
        initialized: true,
        pushed: false,
      };
      item.status = "running";
      item.startedAt = Date.now();
      item.currentPhase = resumePhase;
    });
    await publishSnapshot(runId);
    await logPhase(
      runId,
      "requirements",
      "info",
      `Feature branch ${branches.branch} created from ${branches.baseBranch}.`,
    );

    if (run.options.pipelineTopology && phaseStartIndex <= 2) {
      await finishPhase(runId, "requirements", "skipped", "Replaced by the active custom DAG.");
      await finishPhase(runId, "architecture", "skipped", "Replaced by the active custom DAG.");
      const developer = agents.implementation;
      if (!developer) throw new Error("No developer agent is configured.");
      await beginPhase(runId, "implementation", developer.id);
      await performDependencyHandshake(runId, project, root, developer, controller.signal);
      await logPhase(runId, "implementation", "info", "Executing the exported canvas topology as this run's SDLC graph.");
      const executeGraph = () => executeCanvasTopology(run.options.pipelineTopology!, {
        signal: controller.signal,
        initialInput: run.prompt,
        projectDir: root,
        projectId: project.id,
        runId,
        emit: (event) => {
          if (event.type === "node") {
            void logPhase(
              runId,
              "implementation",
              event.status === "failed" || event.status === "blocked" ? "warn" : "info",
              `Graph node ${event.nodeId}: ${event.status ?? event.type}${event.detail ? ` · ${event.detail}` : ""}`,
            );
          }
        },
      });
      let graph = await executeGraph();
      let graphRepair = 0;
      const graphRepairLimit = Math.min(settings.maxHealAttempts, 3);
      while (!graph.ok && graphRepair < graphRepairLimit) {
        assertActive(runId);
        graphRepair += 1;
        const detail = graph.errors.map((error) => `${error.nodeId}: ${error.error}`).join("; ") || "one or more nodes were blocked";
        const resolutionPath = inferResolutionPath(detail);
        const fileTree = await listWorkspaceFiles(root, 160);
        meshBus.publish({
          type: "VALIDATION_FAILED",
          source: "Canvas dependency gate",
          agentId: developer.id,
          projectId: project.id,
          runId,
          severity: "error",
          title: `Active canvas graph blocked · repair ${graphRepair}/${graphRepairLimit}`,
          message: detail,
          payload: { resolutionPath, fileTree, workspaceRoot: root },
          requiresOverride: false,
        });
        publishAgentEnvelope({
          from: "@canvas-orchestrator",
          to: `@${developer.handle.replace(/^@/, "")}`,
          type: "VALIDATION_REPORT",
          payload: detail,
          timestamp: new Date().toISOString(),
          resolutionPath,
          fileTree,
          workspaceRoot: root,
          status: "FAILED",
        }, { agentId: developer.id, targetAgentId: developer.id, projectId: project.id, runId });
        const repairEvidence = `${detail}\n\nresolutionPath: ${resolutionPath}\nworkspaceRoot: ${root}\nauthoritative fileTree:\n${fileTree.map((file) => `${root}/${file}`).join("\n")}`;
        const repair = await generateFiles(
          runId,
          "implementation",
          developer,
          project,
          root,
          healPrompt(developer, project, run.prompt, repairEvidence, await readWorkspaceContext(root, 24_000), graphRepair),
          `canvas graph repair ${graphRepair}`,
          { guardrailTarget: agents.testing, guardrailStage: "canvas graph repair", signal: controller.signal },
        );
        const repaired = repair.files.length ? await applyFileBlocks(root, repair.files) : { written: [], errors: [] };
        if (!repaired.written.length) break;
        graph = await executeGraph();
      }
      if (!graph.ok) {
        const detail = graph.errors.map((error) => `${error.nodeId}: ${error.error}`).join("; ") || "one or more nodes were blocked";
        const resolutionPath = inferResolutionPath(detail);
        const fileTree = await listWorkspaceFiles(root, 160);
        meshBus.publish({
          type: "VALIDATION_FAILED",
          source: "Canvas dependency gate",
          agentId: developer.id,
          projectId: project.id,
          runId,
          severity: "error",
          title: "Canvas repair budget exhausted",
          message: detail,
          payload: { resolutionPath, fileTree, workspaceRoot: root },
          requiresOverride: false,
        });
        publishAgentEnvelope({
          from: "@canvas-orchestrator",
          to: `@${developer.handle.replace(/^@/, "")}`,
          type: "VALIDATION_REPORT",
          payload: detail,
          timestamp: new Date().toISOString(),
          resolutionPath,
          fileTree,
          workspaceRoot: root,
          status: "BLOCKED",
        }, { agentId: developer.id, targetAgentId: developer.id, projectId: project.id, runId });
        throw new Error(`Active DAG failed after ${graphRepair} repair attempt(s): ${detail}\nresolutionPath: ${resolutionPath}`);
      }
      const generated = Object.values(graph.outputs).flatMap((value) => {
        if (!value || typeof value !== "object" || typeof (value as { text?: unknown }).text !== "string") return [];
        return parseFileBlocks((value as { text: string }).text);
      });
      const byPath = new Map<string, ParsedFile>();
      for (const file of generated) {
        const existing = byPath.get(file.path);
        if (existing && existing.content !== file.content) {
          throw new Error(`Active DAG produced conflicting versions of ${file.path}; assign that path to one agent node.`);
        }
        byPath.set(file.path, file);
      }
      if (!byPath.size) throw new Error("Active DAG completed without producing any parseable files.");
      const applied = await applyFileBlocks(root, Array.from(byPath.values()));
      if (!applied.written.length) throw new Error("The active DAG produced no files that could be written.");
      for (const artifact of applied.written) await addArtifact(runId, artifact);
      await setPhase(runId, "implementation", {
        artifacts: applied.written,
        progress: 100,
      });
      publishArtifactEvent(
        "Active SDLC DAG",
        runId,
        project.id,
        Array.from(byPath.values()).filter((file) => applied.written.includes(file.path)),
        `Active SDLC DAG published ${applied.written.length} file(s)`,
      );
      await commitPhase(runId, root, `feat(${project.slug || "app"}): execute active SDLC DAG`, "implementation");
      await finishPhase(runId, "implementation", "passed");
      const verification = await processTesting(
        runId,
        project,
        root,
        agents,
        run.prompt,
        "Custom SDLC DAG topology",
        settings,
        run.options.allowConcurrency,
      );
      let canvasRuntime = await verifyProjectRuntime({ projectId: project.id, agent: developer, runId });
      let canvasRepair = 0;
      const canvasRepairLimit = Math.min(settings.maxHealAttempts, 3);
      while (!canvasRuntime.passed && canvasRepair < canvasRepairLimit) {
        assertActive(runId);
        canvasRepair += 1;
        await logPhase(runId, "testing", "warn", `Canvas runtime proof failed; repair ${canvasRepair}/${canvasRepairLimit}.`, canvasRuntime.detail.slice(-8_000));
        const repairTree = await listWorkspaceFiles(root, 160);
        const repairEvidence = `${canvasRuntime.detail}\n\nresolutionPath: ${inferResolutionPath(canvasRuntime.detail)}\nworkspaceRoot: ${root}\nauthoritative fileTree:\n${repairTree.map((file) => `${root}/${file}`).join("\n")}`;
        const repair = await generateFiles(
          runId,
          "testing",
          developer,
          project,
          root,
          healPrompt(developer, project, run.prompt, repairEvidence, await readWorkspaceContext(root, 24_000), canvasRepair),
          `canvas runtime proof repair ${canvasRepair}`,
          { guardrailTarget: agents.testing, guardrailStage: "canvas runtime proof repair", signal: controller.signal },
        );
        const repaired = repair.files.length ? await applyFileBlocks(root, repair.files) : { written: [], errors: [] };
        if (!repaired.written.length) break;
        if (project.stack !== "python") await applyNodeManifest(root);
        canvasRuntime = await verifyProjectRuntime({ projectId: project.id, agent: developer, runId });
      }
      if (!canvasRuntime.passed) {
        await finishPhase(runId, "testing", "failed", `Canvas runtime validation failed after ${canvasRepair} repair attempt(s).`);
        throw new Error(`Active DAG runtime validation failed; run cannot be marked complete.\n${canvasRuntime.detail.slice(-8_000)}`);
      }
      await logPhase(runId, "testing", "success", "Canvas runtime proof passed.", canvasRuntime.detail.slice(-4_000));
      await beginPhase(runId, "deployment", agents.deployment?.id);
      await processDeployment(
        runId,
        project,
        root,
        agents,
        settings,
        formatCommandResults(verification.results).slice(0, 6000),
      );
      const finalGit = await readGitState(root);
      const finalFiles = await listWorkspaceFiles(root, 300);
      await updateRun(runId, (item) => {
        item.status = "passed";
        item.completedAt = Date.now();
        item.currentPhase = null;
        item.git = { ...item.git, ...finalGit };
        item.artifacts.fileTree = finalFiles;
        item.artifacts.summary = `Built ${project.name} with the active custom DAG · ${finalFiles.length} files.`;
      });
      const finalRun = await getRun(runId);
      if (finalRun) {
        runEvents.publish(runId, { type: "snapshot", run: finalRun });
        runEvents.publish(runId, { type: "done", runId, status: "passed" });
      }
      await saveProject({ ...project, lastRunId: runId, updatedAt: Date.now() });
      return;
    }

    let spec = "";
    let specTokens = 0;
    if (phaseStartIndex <= 0) {
    // Phase 1 — Requirements
    const pm = agents.requirements;
    if (!pm) throw new Error("No product agent is configured.");
    await beginPhase(runId, "requirements", pm.id);
    await setPhase(runId, "requirements", { progress: 25 });
    const specOutcome = await generateWithAgent({
      agent: pm,
      messages: specPrompt(pm, project, project.description),
      purpose: "requirements specification",
      runId,
      projectDir: root,
      priority: 8,
      signal: controller.signal,
      onStatus: (status) => {
        void logPhase(runId, "requirements", status.stage === "fallback" ? "warn" : "info", status.message);
      },
    });
    spec = specOutcome.result.text;
    specTokens = specOutcome.result.outputTokens;
    let specGuard = await guardHandoff(
      runId,
      "requirements",
      pm,
      agents.architecture ?? pm,
      spec,
      "requirements",
    );
    let specRetry = 0;
    while (!specGuard.passed && specRetry < settings.guardrailMaxRetries) {
      specRetry += 1;
      await logPhase(
        runId,
        "requirements",
        "warn",
        `Guardrail corrective retry ${specRetry}/${settings.guardrailMaxRetries} for ${pm.name}.`,
        correctiveInstruction(specGuard),
      );
      const repaired = await generateWithAgent({
        agent: pm,
        messages: [
          ...specPrompt(pm, project, project.description),
          { role: "user", content: correctiveInstruction(specGuard) },
        ],
        purpose: `requirements specification · guardrail repair ${specRetry}`,
        runId,
        projectDir: root,
        priority: 8,
        signal: controller.signal,
      });
      spec = repaired.result.text;
      specGuard = await guardHandoff(
        runId,
        "requirements",
        pm,
        agents.architecture ?? pm,
        spec,
        "requirements",
      );
    }
    await writeProjectFile(root, "docs/SPEC.md", spec);
    await addArtifact(runId, "docs/SPEC.md");
    publishArtifactEvent(
      pm.name,
      runId,
      project.id,
      [{ path: "docs/SPEC.md", content: spec }],
      `${pm.name} published the product specification`,
    );
    await setPhase(runId, "requirements", {
      artifacts: ["docs/SPEC.md"],
      progress: 90,
    });
    await logPhase(
      runId,
      "requirements",
      "success",
      `${pm.name} produced ${spec.length} chars of specification · ${specTokens} tokens.`,
    );
    await commitPhase(
      runId,
      root,
      `docs(spec): capture requirements for ${project.slug || "app"}`,
      "requirements",
    );
    await finishPhase(runId, "requirements", "passed");
    assertActive(runId);
    } else {
      spec = await fs.readFile(path.join(root, "docs/SPEC.md"), "utf8").catch(() => project.description);
    }

    let architecture = "";
    let architectureTokens = 0;
    if (phaseStartIndex <= 1) {
    // Phase 2 — Architecture
    const architect = agents.architecture;
    if (!architect) throw new Error("No architecture agent is configured.");
    await beginPhase(runId, "architecture", architect.id);
    await setPhase(runId, "architecture", { progress: 30 });
    const archOutcome = await generateWithAgent({
      agent: architect,
      messages: architecturePrompt(architect, project, project.description, spec),
      purpose: "architecture plan",
      runId,
      projectDir: root,
      priority: 7,
      signal: controller.signal,
      onStatus: (status) => {
        void logPhase(runId, "architecture", status.stage === "fallback" ? "warn" : "info", status.message);
      },
    });
    architecture = archOutcome.result.text;
    architectureTokens = archOutcome.result.outputTokens;
    let archGuard = await guardHandoff(
      runId,
      "architecture",
      architect,
      agents.implementation ?? architect,
      architecture,
      "architecture",
    );
    let archRetry = 0;
    while (!archGuard.passed && archRetry < settings.guardrailMaxRetries) {
      archRetry += 1;
      await logPhase(
        runId,
        "architecture",
        "warn",
        `Guardrail corrective retry ${archRetry}/${settings.guardrailMaxRetries} for ${architect.name}.`,
        correctiveInstruction(archGuard),
      );
      const repaired = await generateWithAgent({
        agent: architect,
        messages: [
          ...architecturePrompt(architect, project, project.description, spec),
          { role: "user", content: correctiveInstruction(archGuard) },
        ],
        purpose: `architecture plan · guardrail repair ${archRetry}`,
        runId,
        projectDir: root,
        priority: 7,
        signal: controller.signal,
      });
      architecture = repaired.result.text;
      archGuard = await guardHandoff(
        runId,
        "architecture",
        architect,
        agents.implementation ?? architect,
        architecture,
        "architecture",
      );
    }
    await writeProjectFile(root, "docs/ARCHITECTURE.md", architecture);
    await addArtifact(runId, "docs/ARCHITECTURE.md");
    publishArtifactEvent(
      architect.name,
      runId,
      project.id,
      [{ path: "docs/ARCHITECTURE.md", content: architecture }],
      `${architect.name} published the architecture contract`,
    );
    await setPhase(runId, "architecture", {
      artifacts: ["docs/ARCHITECTURE.md"],
      progress: 90,
    });
    await logPhase(
      runId,
      "architecture",
      "success",
      `${architect.name} mapped the architecture · ${architectureTokens} tokens.`,
    );
    await commitPhase(
      runId,
      root,
      `docs(arch): map architecture and file tree for ${project.slug || "app"}`,
      "architecture",
    );
    await finishPhase(runId, "architecture", "passed");
    assertActive(runId);
    } else {
      architecture = await fs.readFile(path.join(root, "docs/ARCHITECTURE.md"), "utf8").catch(() => "");
    }

    if (phaseStartIndex <= 2) {
    // Phase 3 — Implementation
    const developer = agents.implementation;
    if (!developer) throw new Error("No developer agent is configured.");
    await beginPhase(runId, "implementation", developer.id);
    const implFiles = await processImplementation(
      runId,
      project,
      root,
      agents,
      spec,
      architecture,
      run.options.allowConcurrency,
      controller.signal,
      taskPlan,
    );
    await addArtifact(runId, "docs/SPEC.md");
    await finishPhase(runId, "implementation", "passed");
    await logPhase(
      runId,
      "implementation",
      "success",
      `Implementation complete with ${implFiles.length} generated file(s).`,
    );
    assertActive(runId);
    }

    let verification = {
      results: (await getRun(runId))?.phases.find((phase) => phase.id === "testing")?.commands ?? [],
      failed: false,
    };
    if (phaseStartIndex <= 3) {
    // Phase 4 — Testing & Self-Healing
    await beginPhase(runId, "testing", agents.testing?.id);
    verification = await processTesting(
      runId,
      project,
      root,
      agents,
      spec,
      architecture,
      settings,
      run.options.allowConcurrency,
    );
    assertActive(runId);
    }

    // Phase 5 — Deployment & CI
    await beginPhase(runId, "deployment", agents.deployment?.id);
    const testSummary = formatCommandResults(verification.results).slice(0, 6000);
    await processDeployment(runId, project, root, agents, settings, testSummary);

    const finalGit = await readGitState(root);
    const finalFiles = await listWorkspaceFiles(root, 300);
    const healCount = (await getRun(runId))?.phases.reduce(
      (sum, phase) => sum + phase.healAttempts.length,
      0,
    ) ?? 0;
    await updateRun(runId, (item) => {
      item.status = "passed";
      item.completedAt = Date.now();
      item.currentPhase = null;
      item.git = { ...item.git, ...finalGit };
      item.artifacts.fileTree = finalFiles;
      item.artifacts.summary = `Built ${project.name} with ${finalFiles.length} files, ${healCount} self-heal attempt(s), branch ${finalGit.branch ?? item.git.branch}.`;
    });
    const finalRun = await getRun(runId);
    if (finalRun) {
      runEvents.publish(runId, { type: "snapshot", run: finalRun });
      runEvents.publish(runId, { type: "done", runId, status: "passed" });
    }
    await saveProject({ ...project, lastRunId: runId, updatedAt: Date.now() });
  } catch (error) {
    const aborted =
      (error instanceof DOMException && error.name === "AbortError") ||
      activeRuns.get(runId)?.cancelled;
    const status: RunStatus = aborted ? "cancelled" : "failed";
    const current = await getRun(runId);
    const currentPhase = current?.currentPhase;
    if (currentPhase) {
      await setPhase(runId, currentPhase, {
        status: aborted ? "skipped" : "failed",
        error: aborted ? "Cancelled by user." : String(error).slice(0, 1200),
        completedAt: Date.now(),
      });
    }
    await updateRun(runId, (item) => {
      item.status = status;
      item.error = aborted ? "Cancelled by user." : String(error).slice(0, 2000);
      item.completedAt = Date.now();
      item.currentPhase = null;
    });
    const finalRun = await getRun(runId);
    if (finalRun) {
      runEvents.publish(runId, { type: "snapshot", run: finalRun });
      runEvents.publish(runId, { type: "done", runId, status });
    }
    runEvents.publish(runId, {
      type: "error",
      runId,
      message: aborted ? "Run cancelled." : String(error),
    });
  } finally {
    activeRuns.delete(runId);
  }
}

export async function startRun(input: {
  projectId: string;
  prompt: string;
  maxHealAttempts?: number;
  allowConcurrency?: boolean;
  pushToGitHub?: boolean;
  pipelineTopology?: Run["options"]["pipelineTopology"];
}): Promise<Run> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error("Project not found.");
  const settings = await getSettings();
  const runId = uid("run");
  const branch = branchNameFor(project.slug);
  const run: Run = {
    id: runId,
    projectId: project.id,
    projectName: project.name,
    prompt: input.prompt,
    status: "queued",
    currentPhase: "requirements",
    phases: createPhases(),
    git: { initialized: false, commits: [], dirtyFiles: 0, pushed: false, branch },
    artifacts: { fileTree: [] },
    options: {
      maxHealAttempts: input.maxHealAttempts ?? settings.maxHealAttempts,
      allowConcurrency: input.allowConcurrency ?? false,
      pushToGitHub: input.pushToGitHub ?? false,
      pipelineTopology: input.pipelineTopology,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveRun(run);
  await saveProject({ ...project, lastRunId: runId, updatedAt: Date.now() });
  runEvents.publish(runId, { type: "snapshot", run });
  activeRuns.set(runId, { controller: new AbortController(), cancelled: false });
  void executeRun(runId);
  return run;
}

export async function cancelRun(runId: string): Promise<boolean> {
  const active = activeRuns.get(runId);
  if (active) {
    active.cancelled = true;
    active.controller.abort();
  }
  const run = await getRun(runId);
  if (!run) return false;
  if (run.status === "queued" || run.status === "running") {
    await updateRun(runId, (item) => {
      item.status = "cancelled";
      item.completedAt = Date.now();
      item.error = "Cancelled by user.";
      item.currentPhase = null;
    });
    runEvents.publish(runId, { type: "done", runId, status: "cancelled" });
    return true;
  }
  return false;
}

export async function resumeRun(runId: string): Promise<Run> {
  const run = await getRun(runId);
  if (!run) throw new Error("Run not found.");
  if (run.status !== "recoverable_paused" && run.status !== "interrupted") {
    throw new Error("Only a run paused by a server restart can be resumed here.");
  }
  const phaseId = run.currentPhase ?? "requirements";
  const controller = new AbortController();
  activeRuns.set(runId, { controller, cancelled: false });
  await updateRun(runId, (item) => {
    item.status = "queued";
    item.error = undefined;
    item.completedAt = undefined;
    item.currentPhase = phaseId;
    item.updatedAt = Date.now();
  });
  const snapshot = await getRun(runId);
  if (snapshot) runEvents.publish(runId, { type: "snapshot", run: snapshot });
  void executeRun(runId, phaseId);
  return snapshot!;
}

export async function rerunPhase(runId: string, phaseId: PhaseId): Promise<Run> {
  const run = await getRun(runId);
  const project = run ? await getProject(run.projectId) : undefined;
  if (!run || !project) throw new Error("Run or project not found.");
  const settings = await getSettings();
  const agents = resolveAgents(await listAgents());
  const active = new AbortController();
  activeRuns.set(runId, { controller: active, cancelled: false });
  await updateRun(runId, (item) => {
    item.status = "running";
    item.completedAt = undefined;
    item.error = undefined;
    const phase = item.phases.find((entry) => entry.id === phaseId);
    if (phase) {
      phase.status = "running";
      phase.error = undefined;
      phase.startedAt = Date.now();
      phase.completedAt = undefined;
      phase.progress = 5;
    }
    item.currentPhase = phaseId;
  });
  runEvents.publish(runId, { type: "snapshot", run: (await getRun(runId))! });

  void (async () => {
    try {
      const root = project.workspacePath;
      const spec = await fs
        .readFile(path.join(root, "docs/SPEC.md"), "utf8")
        .catch(() => project.description);
      const architecture = await fs
        .readFile(path.join(root, "docs/ARCHITECTURE.md"), "utf8")
        .catch(() => "");
      if (phaseId === "implementation") {
        await processImplementation(runId, project, root, agents, spec, architecture, run.options.allowConcurrency, active.signal);
      } else if (phaseId === "testing") {
        await processTesting(runId, project, root, agents, spec, architecture, settings, run.options.allowConcurrency);
      } else if (phaseId === "deployment") {
        const current = await getRun(runId);
        await processDeployment(
          runId,
          project,
          root,
          agents,
          settings,
          current?.artifacts.summary ?? "Tests passed in the testing phase.",
        );
      } else {
        throw new Error(`Rerunning the ${phaseId} phase is not supported yet.`);
      }
      await updateRun(runId, (item) => {
        item.status = "passed";
        item.completedAt = Date.now();
        item.currentPhase = null;
      });
      const final = await getRun(runId);
      if (final) runEvents.publish(runId, { type: "done", runId, status: "passed" });
    } catch (error) {
      await setPhase(runId, phaseId, {
        status: "failed",
        error: String(error).slice(0, 1200),
      });
      await updateRun(runId, (item) => {
        item.status = "failed";
        item.error = String(error).slice(0, 2000);
        item.currentPhase = null;
      });
      runEvents.publish(runId, { type: "error", runId, message: String(error) });
    } finally {
      activeRuns.delete(runId);
    }
  })();
  return (await getRun(runId))!;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}
