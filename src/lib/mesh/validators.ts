import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listModels } from "../providers/catalog";
import { generateWithAgent } from "../providers/router";
import { getAgent, getProject } from "../db";
import { runServerHealthProbe, runTerminalCommand, type RuntimeCommandEvent } from "../runtime/sandbox";
import type { RuntimeProof, TaskContract } from "./accountability";
import type { CommandResult } from "../types";
import type {
  Agent,
  HandoffSummary,
  MeshEvent,
  ModelInfo,
  ValidationFinding,
  ValidationReport,
} from "../types";
import { uid } from "../utils";
import { appendConstraint } from "./agent-memory";
import { inferResolutionPath, meshBus, publishAgentEnvelope, setMeshAgentStatus } from "./event-bus";
import { listWorkspaceFiles, resolveInside } from "../workspace";
import { completeTaskStorage, ensureStorageLifecycle } from "../system/storage-cleaner";
import { ensureAnalyticsRuntime, recordContribution, recordPostFlightResult } from "./analytics";
import { sharedCache } from "./shared-cache";

export interface ValidationArtifact {
  path: string;
  content: string;
}

export interface ValidationContext {
  agentId?: string;
  threadId?: string;
  projectId?: string;
  runId?: string;
  reason?: string;
  allowLocalWitness?: boolean;
}

export interface RuntimeValidationResult {
  passed: boolean;
  results: CommandResult[];
  proof?: RuntimeProof;
  detail: string;
}

/** Empirical QA pass for a project after implementation artifacts have been written. */
export async function verifyProjectRuntime(input: {
  projectId: string;
  agent: Pick<Agent, "id" | "name" | "handle">;
  runId?: string;
  onOutput?: (event: RuntimeCommandEvent) => void;
}): Promise<RuntimeValidationResult> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error("Runtime validation requires an existing managed project.");
  const results: CommandResult[] = [];
  const packagePath = path.join(project.workspacePath, "package.json");
  const packageCacheKey = `workspace:${project.workspacePath}:package.json`;
  type PackageManifest = {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageJson = await sharedCache.getOrLoad<PackageManifest | undefined>(
    packageCacheKey,
    async () =>
      fs
        .readFile(packagePath, "utf8")
        .then((value) => JSON.parse(value) as PackageManifest)
        .catch(() => undefined),
    { agentId: input.agent.id, ttlMs: 10 * 60 * 1000 },
  );
  const scripts = packageJson?.scripts ?? {};

  if (project.stack === "python") {
    results.push(await runTerminalCommand({ projectId: project.id, command: "python3 -m unittest discover -s tests -v", timeoutMs: 120_000, onOutput: input.onOutput }));
  } else {
    let compiled = false;
    if (scripts.build) {
      results.push(await runTerminalCommand({ projectId: project.id, command: "npm run build", timeoutMs: 300_000, onOutput: input.onOutput }));
      compiled = true;
    } else if (scripts.typecheck) {
      results.push(await runTerminalCommand({ projectId: project.id, command: "npm run typecheck", timeoutMs: 120_000, onOutput: input.onOutput }));
      compiled = true;
    }
    if (scripts.test) {
      results.push(await runTerminalCommand({ projectId: project.id, command: "npm test", timeoutMs: 180_000, onOutput: input.onOutput }));
    } else if (!compiled) {
      results.push(await runTerminalCommand({ projectId: project.id, command: "node --test", timeoutMs: 120_000, onOutput: input.onOutput }));
    }
  }

  const prismaSchema = path.join(project.workspacePath, "prisma", "schema.prisma");
  const hasPrisma = Boolean(packageJson?.dependencies?.prisma || packageJson?.devDependencies?.prisma || await fs.access(prismaSchema).then(() => true).catch(() => false));
  if (hasPrisma && await fs.access(prismaSchema).then(() => true).catch(() => false)) {
    results.push(await runTerminalCommand({ projectId: project.id, command: "npx prisma validate", timeoutMs: 60_000, onOutput: input.onOutput }));
  }
  if (scripts.start && !results.some((result) => result.exitCode !== 0)) {
    results.push(await runServerHealthProbe(project.id, { timeoutMs: 25_000, onOutput: input.onOutput }));
  }

  const passed = results.length > 0 && results.every((result) => result.exitCode === 0 && !result.timedOut);
  const detail = results.map((result) => `$ ${result.command} · exit ${result.exitCode}\n${result.stderr || result.stdout}`)
    .join("\n\n").slice(-20_000);
  if (!passed) {
    const fileTree = await listWorkspaceFiles(project.workspacePath, 160);
    const resolutionPath = inferResolutionPath(detail);
    await appendConstraint({
      agentId: input.agent.id,
      agentName: input.agent.name,
      source: "error",
      rule: "Before completing implementation work, run the project runtime verification and fix every reported build, test, schema, or startup error.",
      evidence: detail,
    });
    meshBus.publish({
      type: "TEST_FAILED",
      source: "Runtime QA Validator",
      agentId: input.agent.id,
      runId: input.runId,
      projectId: project.id,
      severity: "error",
      title: "Runtime proof failed",
      message: detail.slice(-1_200),
      payload: { results, resolutionPath, fileTree, workspaceRoot: project.workspacePath },
    });
    publishAgentEnvelope({
      from: "@runtime-qa",
      to: `@${input.agent.handle.replace(/^@/, "")}`,
      type: "VALIDATION_REPORT",
      payload: detail.slice(-4_000),
      timestamp: new Date().toISOString(),
      resolutionPath,
      fileTree,
      workspaceRoot: project.workspacePath,
      status: "FAILED",
    }, { agentId: input.agent.id, targetAgentId: input.agent.id, projectId: project.id, runId: input.runId });
  }
  const proof: RuntimeProof | undefined = passed
    ? {
        commandExecuted: results.map((result) => result.command).join(" && "),
        exitCode: 0,
        stdout: results.map((result) => result.stdout).join("\n").slice(-20_000),
        stderr: results.map((result) => result.stderr).join("\n").slice(-20_000),
        timestamp: new Date().toISOString(),
      }
    : undefined;
  return { passed, results, proof, detail };
}

interface QueueItem {
  artifacts: ValidationArtifact[];
  context: ValidationContext;
  hash: string;
}

interface ValidatorGlobal {
  __factoryValidatorRuntime?: boolean;
  __factoryValidatorQueue?: QueueItem[];
  __factoryValidatorBusy?: boolean;
  __factoryValidatorSeen?: Set<string>;
}

const globalStore = globalThis as typeof globalThis & ValidatorGlobal;
const seen = (globalStore.__factoryValidatorSeen ??= new Set<string>());
const queue = (globalStore.__factoryValidatorQueue ??= []);

function safePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 220) || "generated-output";
}

export function extractArtifacts(event: MeshEvent): ValidationArtifact[] {
  const payload = event.payload ?? {};
  const artifacts: ValidationArtifact[] = [];
  const rawFiles = payload.files;
  if (Array.isArray(rawFiles)) {
    for (const file of rawFiles.slice(0, 40)) {
      if (!file || typeof file !== "object") continue;
      const record = file as Record<string, unknown>;
      const path = typeof record.path === "string" ? safePath(record.path) : "generated-file";
      const content =
        typeof record.content === "string"
          ? record.content
          : typeof record.text === "string"
            ? record.text
            : "";
      if (content.trim()) artifacts.push({ path, content });
    }
  }
  if (!artifacts.length) {
    const content =
      typeof payload.content === "string"
        ? payload.content
        : typeof payload.output === "string"
          ? payload.output
          : typeof payload.failure === "string"
            ? payload.failure
            : event.message;
    if (content?.trim()) {
      artifacts.push({
        path: typeof payload.path === "string" ? safePath(payload.path) : "mesh-output",
        content,
      });
    }
  }
  return artifacts;
}

function finding(
  code: string,
  title: string,
  detail: string,
  suggestion: string,
  options: {
    severity?: ValidationFinding["severity"];
    path?: string;
  } = {},
): ValidationFinding {
  return {
    id: uid("find"),
    code,
    title,
    detail,
    suggestion,
    severity: options.severity ?? "warning",
    path: options.path,
  };
}

function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Cheap deterministic checks always run, even when every local model is
 * offline. Those checks produce actionable guardrails; the lightweight model
 * is asked to catch ambiguous semantic issues on top.
 */
export function inspectArtifacts(artifacts: ValidationArtifact[]): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const joined = artifacts.map((artifact) => `${artifact.path}\n${artifact.content}`).join("\n\n");
  const hasTests = artifacts.some((artifact) => isTestFile(artifact.path));

  for (const artifact of artifacts) {
    const content = artifact.content;
    if (!content.trim()) {
      findings.push(
        finding(
          "EMPTY_ARTIFACT",
          "Empty artifact",
          `${artifact.path} was published with no content.`,
          "Regenerate a complete file or remove the empty artifact from the handoff.",
          { severity: "error", path: artifact.path },
        ),
      );
      continue;
    }

    const secretMatches = content.matchAll(
      /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/gi,
    );
    for (const match of secretMatches) {
      if (/process\.env|import\.meta\.env|\$\{|<[^>]+>|example|placeholder|changeme/i.test(match[0])) {
        continue;
      }
      findings.push(
        finding(
          "HARDCODED_SECRET",
          "Possible hard-coded secret",
          `${artifact.path} appears to contain a literal credential.`,
          "Move the value into an environment variable and rotate the exposed secret.",
          { severity: "error", path: artifact.path },
        ),
      );
      break;
    }

    if (/\beval\s*\(|new\s+Function\s*\(/.test(content)) {
      findings.push(
        finding(
          "DYNAMIC_EXECUTION",
          "Dynamic code execution",
          `${artifact.path} uses eval or new Function.`,
          "Replace dynamic execution with an allow-listed parser or explicit branching.",
          { severity: "error", path: artifact.path },
        ),
      );
    }

    if (/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(content) && !/sanitize|DOMPurify/.test(content)) {
      findings.push(
        finding(
          "UNSANITIZED_HTML",
          "Unsanitised HTML sink",
          `${artifact.path} writes HTML without a visible sanitiser.`,
          "Use a sanitiser or render structured text instead of raw HTML.",
          { severity: "error", path: artifact.path },
        ),
      );
    }

    if (/https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[a-z0-9.-]+/i.test(content) && /fetch\s*\(|axios|request\s*\(/i.test(content)) {
      const insecure = /http:\/\/(?!localhost|127\.0\.0\.1)/i.test(content);
      if (insecure) {
        findings.push(
          finding(
            "INSECURE_TRANSPORT",
            "Insecure remote transport",
            `${artifact.path} makes a plaintext HTTP request.`,
            "Use HTTPS for remote providers and keep insecure HTTP local-only.",
            { severity: "warning", path: artifact.path },
          ),
        );
      }
    }

    if (/child_process|execSync|spawnSync/.test(content) && /\$\{|req\.|input|user/i.test(content)) {
      findings.push(
        finding(
          "SHELL_INJECTION_RISK",
          "Shell interpolation risk",
          `${artifact.path} appears to interpolate external values into a process call.`,
          "Pass arguments as an array to execFile/spawn and validate every user-controlled value.",
          { severity: "error", path: artifact.path },
        ),
      );
    }

    if (/\.json$/i.test(artifact.path)) {
      try {
        JSON.parse(content);
      } catch (error) {
        findings.push(
          finding(
            "MALFORMED_JSON",
            "Malformed JSON artifact",
            `${artifact.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            "Regenerate the complete JSON document with valid quoting, commas and brackets before handing it off.",
            { severity: "error", path: artifact.path },
          ),
        );
      }
    }

    if (/\.(md|mdx)$/i.test(artifact.path)) {
      const fenceCount = content.match(/^\s*```/gm)?.length ?? 0;
      if (fenceCount % 2 !== 0) {
        findings.push(
          finding(
            "MALFORMED_MARKDOWN",
            "Unclosed Markdown fence",
            `${artifact.path} contains an odd number of fenced code blocks (${fenceCount}).`,
            "Close every fenced block with a matching triple-backtick line before handing the document off.",
            { severity: "error", path: artifact.path },
          ),
        );
      }
      const jsonBlocks = content.matchAll(/```json\s*\n([\s\S]*?)```/gi);
      for (const block of jsonBlocks) {
        try {
          JSON.parse(block[1]);
        } catch {
          findings.push(
            finding(
              "MALFORMED_JSON",
              "Broken JSON example",
              `${artifact.path} contains a fenced JSON block that cannot be parsed.`,
              "Fix the JSON example so consumers can copy a valid payload.",
              { severity: "error", path: artifact.path },
            ),
          );
          break;
        }
      }
    }

    const placeholders = content.match(
      /(?:\/\/|#|\/\*|<!--|^\s*)\s*(TODO|FIXME|XXX|HACK|implement later|placeholder)\b[^\n]*/gim,
    );
    if (placeholders?.length) {
      findings.push(
        finding(
          "UNRESOLVED_PLACEHOLDER",
          "Unresolved implementation marker",
          `${artifact.path} contains ${placeholders.length} placeholder marker(s): ${placeholders[0].trim().slice(0, 120)}`,
          "Replace placeholders with a complete implementation or document the explicit deferral.",
          { severity: "warning", path: artifact.path },
        ),
      );
    }
  }

  if (artifacts.length && !hasTests) {
    findings.push(
      finding(
        "NO_TEST_COVERAGE",
        "Change has no accompanying tests",
        "The published artifact bundle does not contain a test file.",
        "Ask the QA agent to cover the changed contract, including one failure path.",
        { severity: "warning" },
      ),
    );
  }

  if (/\bFAIL\b|AssertionError|Error: expected|exit code [1-9]/i.test(joined) && /test|spec/i.test(joined)) {
    findings.push(
      finding(
        "TEST_SIGNAL",
        "Failure signal in output",
        "The artifact contains a failing test or non-zero verification signal.",
        "Route the raw failure output back to the developer before accepting the handoff.",
        { severity: "error" },
      ),
    );
  }

  if (!findings.length) {
    findings.push(
      finding(
        "STATIC_CLEAN",
        "Static checks clean",
        `${artifacts.length} artifact(s) passed deterministic checks.`,
        "No action required.",
        { severity: "info" },
      ),
    );
  }
  return findings;
}

export interface PostFlightInput {
  contract: TaskContract;
  agent: Pick<Agent, "id" | "name" | "handle">;
  workspaceRoot?: string;
  fileTree?: string[];
  /** In-memory files, used for canvas nodes that publish without writing. */
  artifacts?: ValidationArtifact[];
  projectId?: string;
  threadId?: string;
  runId?: string;
}

export interface VerifiedArtifact {
  path: string;
  exists: boolean;
  bytes: number;
}

export interface PostFlightResult {
  passed: boolean;
  artifacts: VerifiedArtifact[];
  findings: ValidationFinding[];
  summary: HandoffSummary;
  resolutionPath?: string;
  checkedAt: number;
}

const TEXT_ARTIFACT = /\.(?:[cm]?[jt]sx?|json|md|mdx|css|scss|html|py|txt|yml|yaml|sh|sql|prisma)$/i;

function threeSentenceSummary(
  contract: TaskContract,
  agent: Pick<Agent, "name">,
  files: string[],
  passed: boolean,
  findings: ValidationFinding[],
): HandoffSummary {
  const objective = contract.objective.replace(/\s+/g, " ").replace(/[.!?]+/g, " ").trim().slice(0, 180);
  const list = files.length ? files.slice(0, 8).join(", ") : "no workspace files";
  const actionable = findings.filter((item) => item.severity !== "info");
  const blocker = actionable.find((item) => item.severity === "error" || item.code === "UNRESOLVED_PLACEHOLDER");
  const first = `${agent.name} completed the contracted objective: ${objective || "assigned task"}.`;
  const second = `The handoff points to ${files.length} verified artifact${files.length === 1 ? "" : "s"}: ${list}${files.length > 8 ? ", …" : ""}.`;
  const third = passed
    ? `Post-flight checks passed with ${actionable.length} advisory finding${actionable.length === 1 ? "" : "s"} and the output is ready for the next peer.`
    : `Post-flight is blocked by ${blocker?.title ?? "an artifact verification failure"}; the next peer must not start until the attached resolution path is applied.`;
  return {
    summary: `${first} ${second} ${third}`,
    modifiedFiles: files,
    verifiedArtifacts: files.length,
    findings: actionable.length,
  };
}

/**
 * Mandatory post-flight gate. Physical artifacts are checked from disk; the
 * same bundle is then passed through the deterministic self-consistency and
 * sanitisation audit before a handoff summary is emitted.
 */
export async function verifyPostFlight(input: PostFlightInput): Promise<PostFlightResult> {
  const required = Array.from(new Set(input.contract.requiredArtifacts.map((file) => file.replace(/\\/g, "/").replace(/^\/+/, "")))).filter(Boolean);
  const verified: VerifiedArtifact[] = [];
  const findings: ValidationFinding[] = [];
  const audit = new Map<string, ValidationArtifact>();

  for (const artifact of input.artifacts ?? []) {
    const relative = artifact.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (relative) audit.set(relative, { path: relative, content: artifact.content });
  }

  if (required.length && !input.workspaceRoot) {
    findings.push(
      finding(
        "MISSING_WORKSPACE",
        "Post-flight cannot verify workspace artifacts",
        `${input.agent.name} declared ${required.length} output path(s), but no project workspace is attached.`,
        "Attach the target project workspace, write the outputs there, and rerun the post-flight gate.",
        { severity: "error" },
      ),
    );
  }

  for (const relative of required) {
    let bytes = 0;
    let exists = false;
    if (input.workspaceRoot) {
      try {
        const absolute = resolveInside(input.workspaceRoot, relative);
        const stat = await fs.stat(absolute);
        exists = stat.isFile();
        bytes = stat.isFile() ? stat.size : 0;
        if (!stat.isFile()) {
          findings.push(
            finding(
              "ARTIFACT_NOT_FILE",
              "Output path is not a file",
              `${relative} exists but is not a regular file.`,
              "Publish a complete file at this path or remove it from the contract's required artifacts.",
              { severity: "error", path: relative },
            ),
          );
        } else if (bytes === 0) {
          findings.push(
            finding(
              "EMPTY_ARTIFACT",
              "Empty output artifact",
              `${relative} exists but is 0 bytes.`,
              "Regenerate complete non-empty content for this file before handing it off.",
              { severity: "error", path: relative },
            ),
          );
        } else if (TEXT_ARTIFACT.test(relative) && bytes <= 1_000_000) {
          const content = await fs.readFile(absolute, "utf8");
          audit.set(relative, { path: relative, content });
        }
      } catch {
        findings.push(
          finding(
            "MISSING_ARTIFACT",
            "Required output is missing",
            `${relative} does not exist in the workspace.`,
            `Create ${relative} with complete content in the workspace, then rerun the post-flight gate before handoff.`,
            { severity: "error", path: relative },
          ),
        );
      }
    } else if (arrayIncludes(input.artifacts, relative)) {
      exists = true;
      bytes = Buffer.byteLength(audit.get(relative)?.content ?? "", "utf8");
    }
    verified.push({ path: relative, exists, bytes });
  }

  // In-memory outputs that were not written still belong in the handoff
  // pointer list; they were audited for content consistency above.
  for (const [relative, artifact] of audit) {
    if (verified.some((item) => item.path === relative)) continue;
    verified.push({
      path: relative,
      exists: Boolean(artifact.content.trim()),
      bytes: Buffer.byteLength(artifact.content, "utf8"),
    });
  }

  const audits = Array.from(audit.values());
  if (audits.length) {
    findings.push(...inspectArtifacts(audits));
  }

  const blocking = findings.filter(
    (item) => item.severity === "error" || item.code === "UNRESOLVED_PLACEHOLDER" || item.code === "EMPTY_ARTIFACT",
  );
  const passed = blocking.length === 0;
  const firstBlock = blocking[0];
  const resolutionPath = passed
    ? undefined
    : firstBlock?.suggestion ||
      `Create the missing output files (${required.filter((file) => !verified.find((item) => item.path === file)?.exists).join(", ") || "declared artifacts"}), remove placeholders, and rerun post-flight before handoff.`;
  const summary = threeSentenceSummary(input.contract, input.agent, verified.filter((item) => item.exists).map((item) => item.path), passed, findings);
  const fileTree = input.fileTree ?? (input.workspaceRoot ? await listWorkspaceFiles(input.workspaceRoot, 160).catch(() => []) : []);
  ensureStorageLifecycle();
  ensureAnalyticsRuntime();

  if (passed) {
    // Storage lifecycle: drop raw scratchpads and purge transient execution
    // output immediately after the post-flight gate passes. Long-term memory
    // retains only the three-sentence summary and file pointers.
    const storage = await completeTaskStorage({
      agentId: input.agent.id,
      taskId: input.contract.taskId,
      summary: summary.summary,
      modifiedFiles: summary.modifiedFiles,
      workspaceRoot: input.workspaceRoot,
    }).catch(() => undefined);
    await recordContribution(
      input.agent.id,
      verified.filter((item) => item.exists).map((item) => ({ path: item.path, bytes: item.bytes })),
    ).catch(() => undefined);
    await recordPostFlightResult(input.agent.id, input.contract.taskId, true).catch(() => undefined);

    meshBus.publish({
      type: "POST_FLIGHT_PASSED",
      source: input.agent.name,
      target: input.contract.sourceAgent,
      agentId: input.agent.id,
      threadId: input.threadId,
      projectId: input.projectId,
      runId: input.runId,
      severity: "success",
      title: `Post-flight passed · ${input.agent.name}`,
      message: summary.summary,
      payload: {
        contract: input.contract,
        artifacts: verified,
        findings,
        summary,
        fileTree,
        workspaceRoot: input.workspaceRoot,
        analyticsRecorded: true,
        storageCleanup: storage?.cleanup,
        droppedScratchpadEntries: storage?.droppedScratchpadEntries ?? 0,
      },
    });
  } else {
    await recordPostFlightResult(input.agent.id, input.contract.taskId, false).catch(() => undefined);
    meshBus.publish({
      type: "POST_FLIGHT_BLOCKED",
      source: input.agent.name,
      target: input.contract.sourceAgent,
      agentId: input.agent.id,
      threadId: input.threadId,
      projectId: input.projectId,
      runId: input.runId,
      severity: "error",
      title: `Post-flight blocked · ${input.agent.name}`,
      message: `${firstBlock?.detail ?? "Artifact verification failed."}${resolutionPath ? `\nresolutionPath: ${resolutionPath}` : ""}`,
      payload: {
        contract: input.contract,
        artifacts: verified,
        findings,
        summary,
        resolutionPath,
        fileTree,
        workspaceRoot: input.workspaceRoot,
        analyticsRecorded: true,
      },
      requiresOverride: true,
    });
  }

  return {
    passed,
    artifacts: verified,
    findings,
    summary,
    resolutionPath,
    checkedAt: Date.now(),
  };
}

function arrayIncludes(artifacts: ValidationArtifact[] | undefined, relative: string): boolean {
  return Boolean(artifacts?.some((artifact) => artifact.path.replace(/\\/g, "/").replace(/^\/+/, "") === relative));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function pickWitnessModel(): Promise<ModelInfo | undefined> {
  const catalogue = await listModels();
  const local = catalogue.models.filter(
    (model) =>
      model.online &&
      (model.provider === "ollama" || model.provider === "lmstudio"),
  );
  return (
    local
      .slice()
      .sort((a, b) => Number(a.heavy) - Number(b.heavy) || a.vramEstimateMB - b.vramEstimateMB)[0] ??
    undefined
  );
}

function witnessAgent(model: ModelInfo): Agent {
  const now = Date.now();
  return {
    id: "mesh_witness",
    name: "Silent Witness",
    handle: "witness",
    role: "Security & Quality Reviewer",
    description:
      "A lightweight local critic that continuously inspects generated artifacts in the background.",
    systemPrompt:
      "You are the Silent Witness, a terse security and quality reviewer. Inspect code for vulnerabilities, missing tests, hallucinations and incomplete contracts. Return JSON only. Do not rewrite the whole file.",
    modelKey: model.key,
    fallbackModelKey: undefined,
    temperature: 0.05,
    maxTokens: 900,
    allowConcurrency: true,
    enabled: true,
    color: "#f5b544",
    icon: "ShieldCheck",
    createdAt: now,
    updatedAt: now,
  };
}

async function semanticWitness(
  artifacts: ValidationArtifact[],
  context: ValidationContext,
): Promise<{ model?: string; findings: ValidationFinding[] }> {
  if (context.allowLocalWitness === false) return { findings: [] };
  const model = await pickWitnessModel();
  if (!model) return { findings: [] };

  const code = artifacts
    .slice(0, 8)
    .map((artifact) => `--- ${artifact.path} ---\n${artifact.content.slice(0, 6500)}`)
    .join("\n\n")
    .slice(0, 24_000);
  try {
    const outcome = await generateWithAgent({
      agent: witnessAgent(model),
      messages: [
        {
          role: "system",
          content:
            "You are a background code critic. Return ONLY JSON: {\"findings\":[{\"severity\":\"info|warning|error\",\"title\":\"...\",\"detail\":\"...\",\"suggestion\":\"...\",\"path\":\"...\"}]}. Report only concrete, high-confidence issues. An empty array is valid.",
        },
        {
          role: "user",
          content: `Review this generated change bundle for security vulnerabilities, test gaps, contract inconsistencies and hallucinated APIs.\n\n${code}`,
        },
      ],
      purpose: "silent witness review",
      priority: 2,
      allowFallbackOnError: false,
      persistMetric: false,
    });
    const parsed = parseJsonObject(outcome.result.text);
    const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
    const findings = rawFindings
      .slice(0, 8)
      .map((raw) => {
        const record = (raw ?? {}) as Record<string, unknown>;
        const severity =
          record.severity === "error" || record.severity === "warning" || record.severity === "info"
            ? record.severity
            : "warning";
        return finding(
          "WITNESS_REVIEW",
          String(record.title ?? "Silent Witness finding").slice(0, 140),
          String(record.detail ?? "The local critic flagged this change.").slice(0, 600),
          String(record.suggestion ?? "Review and correct before accepting.").slice(0, 500),
          {
            severity,
            path: typeof record.path === "string" ? safePath(record.path) : undefined,
          },
        );
      })
      .filter((item): item is ValidationFinding => Boolean(item));
    return { model: outcome.model.name, findings };
  } catch {
    // Offline / unloaded local models must never block the mesh.
    return { model: model.name, findings: [] };
  }
}

export async function validateArtifacts(
  artifacts: ValidationArtifact[],
  context: ValidationContext = {},
): Promise<ValidationReport> {
  const started = Date.now();
  setMeshAgentStatus("mesh_witness", "validating", "Inspecting artifacts");
  meshBus.publish({
    type: "VALIDATION_STARTED",
    source: "Silent Witness",
    agentId: context.agentId,
    threadId: context.threadId,
    projectId: context.projectId,
    runId: context.runId,
    severity: "info",
    title: "Background validation started",
    message:
      context.reason ??
      `Inspecting ${artifacts.length} artifact(s) for security, coverage and contract drift.`,
    payload: { artifactCount: artifacts.length, paths: artifacts.map((item) => item.path).slice(0, 12) },
  });

  const deterministic = inspectArtifacts(artifacts);
  const semantic = await semanticWitness(artifacts, context);
  const findings = [...deterministic, ...semantic.findings];
  const penalty = findings.reduce(
    (sum, item) => sum + (item.severity === "error" ? 28 : item.severity === "warning" ? 10 : 0),
    0,
  );
  const score = Math.max(0, 100 - penalty);
  const passed = !findings.some((item) => item.severity === "error") && score >= 70;
  const report: ValidationReport = {
    id: uid("val"),
    agentId: context.agentId,
    threadId: context.threadId,
    projectId: context.projectId,
    runId: context.runId,
    score,
    passed,
    witnessModel: semantic.model,
    findings,
    durationMs: Date.now() - started,
    createdAt: Date.now(),
  };

  const actionable = findings.filter((item) => item.severity !== "info");
  const workspaceProject = context.projectId ? await getProject(context.projectId) : undefined;
  const fileTree = workspaceProject ? await listWorkspaceFiles(workspaceProject.workspacePath, 160) : [];
  const resolutionPath = actionable[0]?.suggestion || inferResolutionPath(actionable[0]?.detail ?? "Validator blocked the handoff.");
  meshBus.publish({
    type: passed ? "VALIDATION_PASSED" : "VALIDATION_FAILED",
    source: "Silent Witness",
    agentId: context.agentId,
    threadId: context.threadId,
    projectId: context.projectId,
    runId: context.runId,
    severity: passed ? "success" : "error",
    title: passed ? `Validation passed · ${score}/100` : `Validator block · ${score}/100`,
    message:
      actionable[0]?.detail ??
      `No blocking issues found across ${artifacts.length} artifact(s).`,
    payload: {
      report,
      findings,
      suggestion: actionable[0]?.suggestion,
      witnessModel: report.witnessModel,
      resolutionPath,
      fileTree,
      workspaceRoot: workspaceProject?.workspacePath,
    },
    requiresOverride: !passed,
  });

  if (!passed) {
    const assignedAgent = context.agentId ? await getAgent(context.agentId) : undefined;
    publishAgentEnvelope({
      from: "@silent-witness",
      to: assignedAgent ? `@${assignedAgent.handle.replace(/^@/, "")}` : "@implementation-agent",
      type: "VALIDATION_REPORT",
      payload: actionable.slice(0, 4).map((item) => `${item.title}: ${item.detail}`).join("\n").slice(0, 4_000),
      timestamp: new Date().toISOString(),
      resolutionPath,
      fileTree,
      workspaceRoot: workspaceProject?.workspacePath,
      status: "BLOCKED",
    }, { agentId: assignedAgent?.id ?? context.agentId, targetAgentId: assignedAgent?.id, threadId: context.threadId, projectId: context.projectId, runId: context.runId });
  }

  for (const findingItem of actionable.slice(0, 4)) {
    if (findingItem.code === "STATIC_CLEAN") continue;
    meshBus.publish({
      type:
        findingItem.code === "HARDCODED_SECRET" ||
        findingItem.code === "DYNAMIC_EXECUTION" ||
        findingItem.code === "UNSANITIZED_HTML" ||
        findingItem.code === "SHELL_INJECTION_RISK"
          ? "SECURITY_WARNING"
          : "VALIDATION_FAILED",
      source: "Silent Witness",
      agentId: context.agentId,
      threadId: context.threadId,
      projectId: context.projectId,
      runId: context.runId,
      severity: findingItem.severity === "error" ? "error" : "warning",
      title: findingItem.title,
      message: `${findingItem.detail} ${findingItem.suggestion}`,
      payload: {
        finding: findingItem,
        reportId: report.id,
        resolutionPath: findingItem.suggestion || resolutionPath,
        fileTree,
        workspaceRoot: workspaceProject?.workspacePath,
      },
      requiresOverride: findingItem.severity === "error",
    });
  }

  if (context.agentId && actionable.length) {
    await appendConstraint({
      agentId: context.agentId,
      rule: `${actionable[0].title}: ${actionable[0].suggestion}`,
      source: "validator",
      evidence: actionable.map((item) => item.detail).join("\n").slice(0, 600),
      publish: false,
    });
  }

  setMeshAgentStatus("mesh_witness", "idle", `Last review ${score}/100`);
  return report;
}

const VALIDATION_CACHE_TTL_MS = 60_000;
const validationInflight = new Map<string, Promise<ValidationReport>>();
const validationCache = new Map<string, { report: ValidationReport; at: number }>();

function artifactFingerprint(artifacts: ValidationArtifact[]): string {
  return createHash("sha256")
    .update(artifacts.map((item) => `${item.path}:${item.content}`).join("\n"))
    .digest("hex");
}

/**
 * Single entry point for artifact validation. Dedupes concurrent and
 * recently-completed validations by artifact fingerprint so the chat route
 * and the mesh subscriber never run the Silent Witness twice for the same
 * bundle. The first caller runs `validateArtifacts`; later callers within
 * the TTL await the same promise (and its published events).
 */
export async function validateArtifactsOnce(
  artifacts: ValidationArtifact[],
  context: ValidationContext = {},
): Promise<ValidationReport> {
  const fingerprint = artifactFingerprint(artifacts);
  const cached = validationCache.get(fingerprint);
  if (cached && Date.now() - cached.at < VALIDATION_CACHE_TTL_MS) {
    return cached.report;
  }
  let job = validationInflight.get(fingerprint);
  if (!job) {
    job = validateArtifacts(artifacts, context)
      .then((report) => {
        validationCache.set(fingerprint, { report, at: Date.now() });
        if (validationCache.size > 200) {
          const first = validationCache.keys().next().value;
          if (first) validationCache.delete(first);
        }
        return report;
      })
      .finally(() => {
        validationInflight.delete(fingerprint);
      });
    validationInflight.set(fingerprint, job);
  }
  return job;
}
function enqueue(item: QueueItem): void {
  if (seen.has(item.hash)) return;
  seen.add(item.hash);
  if (seen.size > 300) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  queue.push(item);
  if (queue.length > 12) queue.splice(0, queue.length - 12);
  void drain();
}

async function drain(): Promise<void> {
  if (globalStore.__factoryValidatorBusy) return;
  globalStore.__factoryValidatorBusy = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await validateArtifactsOnce(item.artifacts, item.context);
      } catch {
        // Validators are best-effort observers.
      }
    }
  } finally {
    globalStore.__factoryValidatorBusy = false;
  }
}

function shouldValidate(event: MeshEvent): boolean {
  if (!["ARTIFACT_CREATED", "TEST_FAILED", "SCHEMA_UPDATED"].includes(event.type)) return false;
  if (event.source === "Silent Witness") return false;
  return true;
}

/**
 * Idempotently wires the background critic into the mesh. Called by the SSE
 * endpoint and the chat route so validation works even when no HUD is open.
 */
export function ensureValidatorRuntime(): void {
  if (globalStore.__factoryValidatorRuntime) return;
  globalStore.__factoryValidatorRuntime = true;
  meshBus.subscribeAll((event) => {
    if (!shouldValidate(event)) return;
    const artifacts = extractArtifacts(event);
    if (!artifacts.length) return;
    const fingerprint = createHash("sha256")
      .update(artifacts.map((item) => `${item.path}:${item.content}`).join("\n"))
      .digest("hex");
    enqueue({
      artifacts,
      context: {
        agentId: event.agentId,
        threadId: event.threadId,
        projectId: event.projectId,
        runId: event.runId,
        reason: event.title,
      },
      hash: fingerprint,
    });
  });
}
