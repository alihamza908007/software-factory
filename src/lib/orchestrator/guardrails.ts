import { createHash } from "node:crypto";
import { getSettings } from "../db";
import { parseFileBlocks } from "./parse";
import type {
  DeadLoopInfo,
  GuardrailCheck,
  GuardrailResult,
  HandoffTraceStep,
} from "../types";

export interface GuardrailAgent {
  id: string;
  name: string;
  handle: string;
  role: string;
}

export interface HandoffValidationInput {
  sourceAgent: GuardrailAgent;
  targetAgent: GuardrailAgent;
  payload: string;
  originalRequest?: string;
  traceKey?: string;
  stage?: string;
  threshold?: number;
  maxRetries?: number;
  windowSize?: number;
  loopThreshold?: number;
}

export interface RepairContext {
  attempt: number;
  result: GuardrailResult;
  instruction: string;
}

export type HandoffRepair = (context: RepairContext) => Promise<string>;

export class DeadLoopException extends Error {
  readonly info: DeadLoopInfo;

  constructor(info: DeadLoopInfo) {
    super(info.message);
    this.name = "DEAD_LOOP_EXCEPTION";
    this.info = info;
  }
}

type TraceStore = {
  traces: Map<string, HandoffTraceStep[]>;
};

const globalStore = globalThis as typeof globalThis & {
  __factoryHandoffTraces?: TraceStore;
};
const store = (globalStore.__factoryHandoffTraces ??= { traces: new Map() });

function normalise(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

export function hashPayload(text: string): string {
  return createHash("sha256").update(normalise(text)).digest("hex").slice(0, 20);
}

function pushCheck(checks: GuardrailCheck[], check: GuardrailCheck) {
  checks.push(check);
}

function countFences(payload: string): number {
  return (payload.match(/```/g)?.length ?? 0) / 2;
}

function structuralScore(payload: string): number {
  const blocks = parseFileBlocks(payload);
  const validPaths = blocks.filter(
    (file) =>
      !file.path.startsWith("/") &&
      !file.path.includes("..") &&
      !/^[a-zA-Z]:/.test(file.path),
  );
  return Math.min(100, validPaths.length * 18 + Math.min(40, payload.length / 120));
}

/**
 * Lightweight deterministic classification. This is deliberately local: a
 * guardrail must never consume the same expensive model budget it protects.
 */
export function classifyHandoff(input: HandoffValidationInput): GuardrailResult {
  const threshold = input.threshold ?? 70;
  const payload = input.payload.trim();
  const targetRole = `${input.targetAgent.role} ${input.targetAgent.handle}`.toLowerCase();
  const checks: GuardrailCheck[] = [];
  const errors: string[] = [];

  const lengthScore = payload.length >= 600 ? 20 : payload.length >= 160 ? 14 : payload.length >= 40 ? 7 : 0;
  pushCheck(checks, {
    id: "substance",
    label: "Payload substance",
    level: lengthScore >= 14 ? "pass" : lengthScore > 0 ? "warn" : "fail",
    score: lengthScore,
    detail: `${payload.length} characters supplied.`,
  });
  if (!lengthScore) errors.push("The handoff payload is empty or too short to act on.");

  const headings = (payload.match(/^#{1,4}\s+/gm) ?? []).length;
  const bullets = (payload.match(/^\s*[-*]\s+/gm) ?? []).length;
  const structureScore = headings > 0 || bullets >= 3 ? 15 : bullets > 0 ? 8 : 0;
  pushCheck(checks, {
    id: "structure",
    label: "Structured handoff",
    level: structureScore >= 8 ? "pass" : "warn",
    score: structureScore,
    detail: `${headings} headings, ${bullets} bullet points.`,
  });

  const lower = payload.toLowerCase();
  const ambiguity = ["tbd", "todo", "fixme", "placeholder", "etc.", "somehow"].filter((token) =>
    lower.includes(token),
  );
  const ambiguityScore = Math.max(0, 15 - ambiguity.length * 4);
  pushCheck(checks, {
    id: "ambiguity",
    label: "No unresolved placeholders",
    level: ambiguity.length === 0 ? "pass" : ambiguity.length < 2 ? "warn" : "fail",
    score: ambiguityScore,
    detail: ambiguity.length ? `Found: ${ambiguity.join(", ")}` : "No placeholder markers.",
  });
  if (ambiguity.length >= 2) errors.push(`Remove unresolved placeholders: ${ambiguity.join(", ")}.`);

  const fences = countFences(payload);
  const blocks = parseFileBlocks(payload);
  const safeBlocks = blocks.filter(
    (file) => !file.path.startsWith("/") && !file.path.includes("..") && !/^[a-zA-Z]:/.test(file.path),
  );
  const needsFiles = /developer|engineer|qa|test/i.test(targetRole) || input.stage === "implementation";
  const fileScore = needsFiles
    ? safeBlocks.length >= 2
      ? 25
      : safeBlocks.length === 1
        ? 16
        : 0
    : fences > 0
      ? 20
      : 10;
  pushCheck(checks, {
    id: "artifacts",
    label: needsFiles ? "Executable file blocks" : "Actionable artifacts",
    level: fileScore >= 16 ? "pass" : fileScore > 0 ? "warn" : "fail",
    score: fileScore,
    detail:
      blocks.length > 0
        ? `${safeBlocks.length}/${blocks.length} safe fenced file blocks.`
        : fences > 0
          ? `${fences} fenced blocks without path annotations.`
          : "No fenced artifacts.",
  });
  if (needsFiles && !safeBlocks.length) {
    errors.push("Developer/QA handoffs must contain fenced file blocks with `path=` annotations.");
  }
  if (blocks.length !== safeBlocks.length) {
    errors.push("One or more file paths escape the workspace or are absolute.");
  }

  const addressed =
    lower.includes(input.targetAgent.name.toLowerCase()) ||
    lower.includes(`@${input.targetAgent.handle.toLowerCase()}`) ||
    /implement|review|verify|design|test|deploy|analyse|analyze/i.test(payload);
  pushCheck(checks, {
    id: "routing",
    label: "Target-directed instruction",
    level: addressed ? "pass" : "warn",
    score: addressed ? 12 : 4,
    detail: addressed
      ? `Payload addresses ${input.targetAgent.name} or states an actionable request.`
      : `Payload does not clearly address ${input.targetAgent.name}.`,
  });

  const progressScore = Math.round((structuralScore(payload) / 100) * 13);
  pushCheck(checks, {
    id: "progress",
    label: "Structural progress",
    level: progressScore >= 6 ? "pass" : "warn",
    score: progressScore,
    detail: `Structural progress signal ${progressScore}/13.`,
  });

  const rawScore = checks.reduce((sum, check) => sum + check.score, 0);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const passed = score >= threshold && !checks.some((check) => check.level === "fail");
  const payloadHash = hashPayload(payload);
  const deadLoop = detectDeadLoop({
    traceKey: input.traceKey,
    sourceAgent: input.sourceAgent.name,
    targetAgent: input.targetAgent.name,
    payloadHash,
    windowSize: input.windowSize,
    loopThreshold: input.loopThreshold,
  });

  return {
    id: `gr_${Date.now().toString(36)}_${payloadHash.slice(0, 6)}`,
    sourceAgent: input.sourceAgent.name,
    targetAgent: input.targetAgent.name,
    score,
    passed,
    threshold,
    checks,
    errors,
    payloadHash,
    retryCount: 0,
    deadLoop,
    createdAt: Date.now(),
  };
}

export function detectDeadLoop(input: {
  traceKey?: string;
  sourceAgent: string;
  targetAgent: string;
  payloadHash: string;
  windowSize?: number;
  loopThreshold?: number;
}): DeadLoopInfo {
  if (!input.traceKey) {
    return {
      detected: false,
      transition: `${input.sourceAgent}→${input.targetAgent}`,
      occurrences: 0,
      window: [],
      message: "No trace key supplied.",
    };
  }
  const windowSize = Math.max(3, input.windowSize ?? 5);
  const threshold = Math.max(2, input.loopThreshold ?? 3);
  const trace = store.traces.get(input.traceKey) ?? [];
  const transition = `${input.sourceAgent}→${input.targetAgent}`;
  const step: HandoffTraceStep = {
    sourceAgent: input.sourceAgent,
    targetAgent: input.targetAgent,
    payloadHash: input.payloadHash,
    at: Date.now(),
    progressed: true,
  };
  const next = [...trace, step].slice(-windowSize);
  store.traces.set(input.traceKey, next);

  const occurrences = next.filter(
    (item) =>
      item.sourceAgent === input.sourceAgent &&
      item.targetAgent === input.targetAgent &&
      item.payloadHash === input.payloadHash,
  ).length;

  const detected = occurrences >= threshold;
  return {
    detected,
    transition,
    occurrences,
    window: next,
    message: detected
      ? `Dead loop detected: ${transition} repeated ${occurrences} times without payload progress. Pipeline frozen.`
      : `No dead loop (${occurrences}/${threshold} identical transitions).`,
  };
}

export async function validateAgentHandoff(
  input: HandoffValidationInput,
): Promise<GuardrailResult> {
  const settings = await getSettings();
  return classifyHandoff({
    ...input,
    threshold: input.threshold ?? settings.guardrailThreshold,
    windowSize: input.windowSize ?? settings.deadLoopWindow,
    loopThreshold: input.loopThreshold ?? settings.deadLoopThreshold,
  });
}

/**
 * Validate, then pipe the validator trace back to the source agent for up to
 * two corrective retries. The repair callback is intentionally injected so the
 * engine can use its own provider routing and logging.
 */
export async function validateHandoffWithRepair(
  input: HandoffValidationInput,
  repair?: HandoffRepair,
): Promise<{ result: GuardrailResult; payload: string; repaired: boolean }> {
  const settings = await getSettings();
  const maxRetries = input.maxRetries ?? settings.guardrailMaxRetries;
  let payload = input.payload;
  let result = await validateAgentHandoff({ ...input, payload });
  if (result.deadLoop.detected) throw new DeadLoopException(result.deadLoop);

  let attempt = 0;
  while (!result.passed && attempt < maxRetries && repair) {
    attempt += 1;
    payload = await repair({
      attempt,
      result,
      instruction: correctiveInstruction(result),
    });
    result = await validateAgentHandoff({ ...input, payload });
    result.retryCount = attempt;
    if (result.deadLoop.detected) throw new DeadLoopException(result.deadLoop);
  }
  return { result, payload, repaired: attempt > 0 };
}

export function correctiveInstruction(result: GuardrailResult): string {
  return [
    `Your handoff to ${result.targetAgent} failed guardrail validation with a score of ${result.score}/100 (minimum ${result.threshold}).`,
    "Fix the following issues and re-emit only the corrected handoff payload:",
    ...result.errors.map((error) => `- ${error}`),
    "",
    "Check trace:",
    ...result.checks.map(
      (check) => `- [${check.level}] ${check.label}: ${check.detail} (${check.score} pts)`,
    ),
  ].join("\n");
}

export function resetGuardrailTrace(traceKey: string) {
  store.traces.delete(traceKey);
}

export function getGuardrailTrace(traceKey: string): HandoffTraceStep[] {
  return [...(store.traces.get(traceKey) ?? [])];
}
