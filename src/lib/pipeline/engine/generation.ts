import { promises as fs } from "node:fs";
import path from "node:path";
import { getSettings, listAgents, updateRun } from "@/lib/data/db";
import { getCachedVerification, setCachedVerification, workspaceFingerprint } from "@/lib/data/verification-cache";

import { generateWithAgent } from "@/lib/providers/router";
import { correctiveInstruction } from "@/lib/pipeline/guardrails";
import type { Agent, GuardrailResult, PhaseId, Project } from "@/lib/core/types";

import { inspectWorkspaceHandshake, listWorkspaceFiles, preserveDuplicateRouteFiles, writeProjectFile } from "@/lib/data/workspace";
import { sharedCache } from "@/lib/mesh/shared-cache";
import { applyFileBlocks, parseFileBlocks, type ParsedFile } from "@/lib/pipeline/parse";
import { dependencyHandshakeRepairPrompt } from "@/lib/pipeline/prompts";
import { commitAll, readGitState } from "@/lib/runtime/tools/git";

import { failureDigest, resultsFailed, runInstallIfNeeded, runLint, runTests } from "@/lib/runtime/tools/toolchain";

import { learnFromFailure } from "@/lib/mesh/agent-memory";
import { inferResolutionPath, meshBus, publishAgentEnvelope, setMeshAgentStatus } from "@/lib/mesh/event-bus";

import { logPhase, guardHandoff, assertActive } from "./shared";

export async function applyNodeManifest(root: string) {
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
  sharedCache.delete(`workspace:${root}:package.json`);
}

export function normalizeTestFiles(files: ParsedFile[], stack: Project["stack"]): ParsedFile[] {
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

export async function commitPhase(
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

export async function runVerification(
  runId: string,
  root: string,
  stack: Project["stack"],
  phaseId: PhaseId,
  includeInstall = true,
  allowConcurrency = true,
) {
  const fingerprint = await workspaceFingerprint(root);
  const cached = getCachedVerification(runId, fingerprint);
  if (cached) {
    await logPhase(
      runId,
      phaseId,
      "command",
      "Reusing verification results from an earlier phase — workspace unchanged.",
      cached.results.map((result) => `$ ${result.command} · exit ${result.exitCode}`).join("\n"),
    );
    return { results: cached.results, failed: cached.failed };
  }
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
  if (fingerprint) setCachedVerification(runId, fingerprint, results, failed);
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

export async function generateFiles(
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

export async function performDependencyHandshake(
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

