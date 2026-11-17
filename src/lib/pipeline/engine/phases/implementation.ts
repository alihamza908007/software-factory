import { promises as fs } from "node:fs";
import path from "node:path";
import { getSettings, listAgents, updateRun } from "@/lib/data/db";

import { runEvents } from "@/lib/core/events";

import type { Agent, PhaseId, Project } from "@/lib/core/types";
import { truncate, uid } from "@/lib/core/utils";
import { listWorkspaceFiles, readWorkspaceContext, treeSummary, writeProjectFile } from "@/lib/data/workspace";
import { applyFileBlocks, summarizeFiles, type ParsedFile } from "@/lib/pipeline/parse";
import { healPrompt, implementationPrompt, testPrompt } from "@/lib/pipeline/prompts";

import { formatCommandResults, runTests } from "@/lib/runtime/tools/toolchain";

import { inferResolutionPath, meshBus, publishAgentEnvelope } from "@/lib/mesh/event-bus";
import { verifyPostFlight, verifyProjectRuntime } from "@/lib/mesh/validators";
import { type DecomposedTask } from "@/lib/pipeline/decomposer";

import { acceptTask, completeTaskContract, createTaskContract, inferRequiredCapabilities } from "@/lib/mesh/accountability";
import { executeDag } from "@/lib/pipeline/scheduler";
import { runRepairCycle } from "@/lib/pipeline/repair-engine";

import { logPhase, setPhase, publishArtifactEvent, assertActive } from "../shared";

import { applyNodeManifest, commitPhase, generateFiles, performDependencyHandshake } from "../generation";

export async function processImplementation(
  runId: string,
  project: Project,
  root: string,
  agents: Record<PhaseId, Agent | undefined>,
  spec: string,
  architecture: string,
  allowConcurrency = false,
  signal?: AbortSignal,
  taskPlan: DecomposedTask[] = [],
  healLimit?: number,
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
    maxAttempts: Math.min(healLimit ?? (await getSettings()).maxHealAttempts, 3),
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

