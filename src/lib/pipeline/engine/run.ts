import { promises as fs } from "node:fs";
import path from "node:path";
import { getProject, getRun, getSettings, listAgents, saveProject, saveRun, updateRun } from "@/lib/data/db";
import { createPhases } from "@/lib/core/constants";
import { runEvents } from "@/lib/core/events";
import { generateWithAgent } from "@/lib/providers/router";
import { correctiveInstruction } from "@/lib/pipeline/guardrails";
import type { Agent, PhaseId, Project, Run, RunStatus } from "@/lib/core/types";
import { uid } from "@/lib/core/utils";
import { listWorkspaceFiles, readWorkspaceContext, scaffoldProject, writeProjectFile } from "@/lib/data/workspace";
import { applyFileBlocks, parseFileBlocks, type ParsedFile } from "@/lib/pipeline/parse";
import { architecturePrompt, healPrompt, specPrompt } from "@/lib/pipeline/prompts";
import { branchNameFor, ensureRunBranch, initRepo, readGitState } from "@/lib/runtime/tools/git";

import { formatCommandResults } from "@/lib/runtime/tools/toolchain";

import { inferResolutionPath, meshBus, publishAgentEnvelope } from "@/lib/mesh/event-bus";
import { ensureValidatorRuntime, verifyProjectRuntime } from "@/lib/mesh/validators";
import { decomposeProjectTask, type DecomposedTask } from "@/lib/pipeline/decomposer";
import { negotiateTaskOwnership } from "@/lib/mesh/negotiation";

import { executeCanvasTopology, type DagResumeOptions } from "@/lib/pipeline/scheduler";

import { activeRuns, resolveAgents, publishSnapshot, logPhase, guardHandoff, setPhase, beginPhase, finishPhase, addArtifact, publishArtifactEvent, assertActive } from "./shared";

import { applyNodeManifest, commitPhase, generateFiles, performDependencyHandshake } from "./generation";

import { processImplementation } from "./phases/implementation";
import { processTesting } from "./phases/testing";
import { processDeployment } from "./phases/deployment";

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
  const healLimit = Math.min(run.options.maxHealAttempts ?? settings.maxHealAttempts, 3);
  const effectiveSettings = { ...settings, maxHealAttempts: healLimit };
  const agents = resolveAgents(await listAgents());
  const root = project.workspacePath;
  const resumePhase = resumeFrom ?? "requirements";
  const phaseStartIndex = ["requirements", "architecture", "implementation", "testing", "deployment"].indexOf(resumePhase);
  const controller = activeRuns.get(runId)?.controller ?? new AbortController();
  if (!activeRuns.has(runId)) activeRuns.set(runId, { controller, cancelled: false });

  try {
    const isTopologyRun = Boolean(run.options.pipelineTopology && phaseStartIndex <= 2);
    let taskPlan: DecomposedTask[] = [];
    if (!isTopologyRun) {
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
    const plan = decomposeProjectTask(run.prompt, activeAgents);
    const plannedAgent = (id: string) => {
      const handle = plan.find((task) => task.id === id)?.targetAgent;
      return Object.values(agents).find((agent) => agent && `@${agent.handle.replace(/^@/, "")}` === handle);
    };
    agents.requirements = plannedAgent("task-requirements") ?? agents.requirements;
    agents.architecture = plannedAgent("task-architecture") ?? agents.architecture;
    agents.implementation = plannedAgent("task-implementation") ?? agents.implementation;
    agents.testing = plannedAgent("task-validation") ?? agents.testing;
    taskPlan = plan;
    await logPhase(runId, "requirements", "info", `Deterministic task decomposition created ${plan.length} tasks.`, JSON.stringify(plan, null, 2));
    }
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
      const topology = run.options.pipelineTopology!;
      const rerunClosure = (failedIds: string[]) => {
        const rerun = new Set(failedIds);
        let changed = true;
        while (changed) {
          changed = false;
          for (const edge of topology.edges ?? []) {
            if (rerun.has(edge.source) && !rerun.has(edge.target)) {
              rerun.add(edge.target);
              changed = true;
            }
          }
        }
        return rerun;
      };
      const executeGraph = (resume?: DagResumeOptions) => executeCanvasTopology(topology, {
        signal: controller.signal,
        resume,
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
      const graphRepairLimit = healLimit;
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
        const failedNodes = graph.nodes
          .filter((node) => node.status === "failed" || node.status === "blocked")
          .map((node) => node.id);
        await logPhase(
          runId,
          "implementation",
          "info",
          `Re-running ${failedNodes.length} failed node(s) plus downstream dependants; other nodes reuse their output.`,
        );
        graph = await executeGraph({ outputs: graph.outputs, rerun: rerunClosure(failedNodes) });
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
        effectiveSettings,
        run.options.allowConcurrency,
      );
      let canvasRuntime = await verifyProjectRuntime({ projectId: project.id, agent: developer, runId });
      let canvasRepair = 0;
      const canvasRepairLimit = healLimit;
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
      healLimit,
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
      effectiveSettings,
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
    if (finalRun && finalRun.status !== "cancelled") {
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
      engine: input.pipelineTopology ? "canvas" : "standard",
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
  const storedPhase = run.currentPhase ?? "requirements";
  const firstIncomplete = run.phases.find(
    (phase) => phase.status !== "passed" && phase.status !== "skipped",
  )?.id;
  const resumeTarget = firstIncomplete ?? storedPhase;
  // Canvas runs cannot resume mid-way through the legacy phases; restarting at
  // implementation keeps them on the DAG engine instead of silently switching.
  const phaseId =
    run.options.engine === "canvas" && (resumeTarget === "testing" || resumeTarget === "deployment")
      ? "implementation"
      : resumeTarget;
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
  const healLimit = Math.min(run.options.maxHealAttempts ?? settings.maxHealAttempts, 3);
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
        await processImplementation(runId, project, root, agents, spec, architecture, run.options.allowConcurrency, active.signal, [], healLimit);
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
