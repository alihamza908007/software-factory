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
import type {
  Agent,
  HealAttempt,
  PhaseId,
  Project,
  Run,
  RunStatus,
} from "../types";
import { slugify, truncate, uid } from "../utils";
import {
  listWorkspaceFiles,
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
  await logPhase(runId, phaseId, "command", "Running syntax / lint checks…");
  const lint = await runLint(root, stack);
  for (const result of lint.slice(-12)) {
    await logPhase(
      runId,
      phaseId,
      result.exitCode === 0 ? "info" : "error",
      `$ ${result.command} · exit ${result.exitCode}`,
      (result.stdout + result.stderr).slice(-1600) || undefined,
    );
  }
  await logPhase(runId, phaseId, "command", "Running test suite…");
  const tests = await runTests(root, stack);
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
  return { results, failed: resultsFailed(results) };
}

async function generateFiles(
  runId: string,
  phaseId: PhaseId,
  agent: Agent,
  project: Project,
  root: string,
  messages: Parameters<typeof generateWithAgent>[0]["messages"],
  purpose: string,
  options?: { testFiles?: boolean },
): Promise<{ files: ParsedFile[]; raw: string; outcome: Awaited<ReturnType<typeof generateWithAgent>> }> {
  await logPhase(runId, phaseId, "agent", `${agent.name} (${agent.role}) is generating…`);
  const outcome = await generateWithAgent({
    agent,
    messages,
    purpose,
    runId,
    projectDir: root,
    priority: phaseId === "implementation" ? 9 : phaseId === "testing" ? 8 : 6,
    onStatus: (status) => {
      void logPhase(runId, phaseId, status.stage === "fallback" ? "warn" : "info", status.message);
    },
  });
  await logPhase(
    runId,
    phaseId,
    "success",
    `${agent.name} completed · ${outcome.result.outputTokens} tok · ${outcome.result.tokensPerSec.toFixed(
      1,
    )} tok/s · TTFT ${Math.round(outcome.result.ttftMs)}ms`,
  );
  let files = parseFileBlocks(outcome.result.text);
  if (options?.testFiles && files.length) {
    files = normalizeTestFiles(files, project.stack);
  }
  return { files, raw: outcome.result.text, outcome };
}

async function processImplementation(
  runId: string,
  project: Project,
  root: string,
  agents: Record<PhaseId, Agent | undefined>,
  spec: string,
  architecture: string,
) {
  const developer = agents.implementation;
  if (!developer) throw new Error("No developer agent is configured.");
  const tree = await treeSummary(root);
  const prompt = implementationPrompt(developer, project, project.description, spec, architecture, tree);
  let generated = await generateFiles(
    runId,
    "implementation",
    developer,
    project,
    root,
    prompt,
    "implementation",
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
  await logPhase(
    runId,
    "implementation",
    "success",
    `Wrote ${applied.written.length} files.`,
    summarizeFiles(generated.files),
  );

  if (project.stack === "node" || project.stack === "next") {
    await applyNodeManifest(root);
  }

  const files = await listWorkspaceFiles(root, 300);
  await updateRun(runId, (run) => {
    run.artifacts.fileTree = files;
  });
  const artifacts = generated.files.map((file) => file.path);
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
    { testFiles: true },
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
  let verification = await runVerification(runId, root, project.stack, "testing");
  await updateRun(runId, (run) => {
    const phase = run.phases.find((item) => item.id === "testing");
    if (phase) phase.commands = verification.results;
  });

  let attempt = 0;
  while (verification.failed && attempt < settings.maxHealAttempts) {
    assertActive(runId);
    attempt += 1;
    await setPhase(runId, "testing", {
      progress: Math.min(90, 35 + attempt * 15),
    });
    await logPhase(
      runId,
      "testing",
      "warn",
      `Self-heal attempt ${attempt}/${settings.maxHealAttempts} — dispatching failure logs to ${agents.implementation?.name ?? "developer"}.`,
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

    verification = await runVerification(runId, root, project.stack, "testing", true);
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
    await finishPhase(runId, "deployment", "failed", "Build verification failed.");
    throw new Error("Deployment build verification failed.");
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

async function executeRun(runId: string) {
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
  const controller = activeRuns.get(runId)?.controller ?? new AbortController();
  if (!activeRuns.has(runId)) activeRuns.set(runId, { controller, cancelled: false });

  try {
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
      item.currentPhase = "requirements";
    });
    await publishSnapshot(runId);
    await logPhase(
      runId,
      "requirements",
      "info",
      `Feature branch ${branches.branch} created from ${branches.baseBranch}.`,
    );

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
    const spec = specOutcome.result.text;
    await writeProjectFile(root, "docs/SPEC.md", spec);
    await addArtifact(runId, "docs/SPEC.md");
    await setPhase(runId, "requirements", {
      artifacts: ["docs/SPEC.md"],
      progress: 90,
    });
    await logPhase(
      runId,
      "requirements",
      "success",
      `${pm.name} produced ${spec.length} chars of specification · ${specOutcome.result.outputTokens} tokens.`,
    );
    await commitPhase(
      runId,
      root,
      `docs(spec): capture requirements for ${project.slug || "app"}`,
      "requirements",
    );
    await finishPhase(runId, "requirements", "passed");
    assertActive(runId);

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
    const architecture = archOutcome.result.text;
    await writeProjectFile(root, "docs/ARCHITECTURE.md", architecture);
    await addArtifact(runId, "docs/ARCHITECTURE.md");
    await setPhase(runId, "architecture", {
      artifacts: ["docs/ARCHITECTURE.md"],
      progress: 90,
    });
    await logPhase(
      runId,
      "architecture",
      "success",
      `${architect.name} mapped the architecture · ${archOutcome.result.outputTokens} tokens.`,
    );
    await commitPhase(
      runId,
      root,
      `docs(arch): map architecture and file tree for ${project.slug || "app"}`,
      "architecture",
    );
    await finishPhase(runId, "architecture", "passed");
    assertActive(runId);

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

    // Phase 4 — Testing & Self-Healing
    await beginPhase(runId, "testing", agents.testing?.id);
    const verification = await processTesting(
      runId,
      project,
      root,
      agents,
      spec,
      architecture,
      settings,
    );
    assertActive(runId);

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
        await processImplementation(runId, project, root, agents, spec, architecture);
      } else if (phaseId === "testing") {
        await processTesting(runId, project, root, agents, spec, architecture, settings);
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
