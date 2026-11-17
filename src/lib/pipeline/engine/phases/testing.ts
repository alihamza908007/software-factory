import { promises as fs } from "node:fs";
import path from "node:path";
import { getSettings, updateRun } from "@/lib/data/db";

import { runEvents } from "@/lib/core/events";

import type { Agent, HealAttempt, PhaseId, Project } from "@/lib/core/types";
import { truncate } from "@/lib/core/utils";
import { readWorkspaceContext, treeSummary } from "@/lib/data/workspace";
import { applyFileBlocks, summarizeFiles } from "@/lib/pipeline/parse";
import { healPrompt, testPrompt } from "@/lib/pipeline/prompts";

import { failureDigest, formatCommandResults } from "@/lib/runtime/tools/toolchain";

import { logPhase, setPhase, finishPhase, publishArtifactEvent, assertActive } from "../shared";

import { applyNodeManifest, commitPhase, runVerification, generateFiles } from "../generation";

export async function processTesting(
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

