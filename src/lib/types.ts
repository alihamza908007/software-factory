export type ModelProvider =
  | "ollama"
  | "lmstudio"
  | "opencode"
  | "openrouter"
  | "anthropic"
  | "openai"
  | "google";

export type ModelKind = "local" | "cloud";

export interface ModelInfo {
  key: string;
  provider: ModelProvider;
  modelId: string;
  name: string;
  kind: ModelKind;
  contextLength?: number;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  capabilities: string[];
  heavy: boolean;
  vramEstimateMB: number;
  costInputPerMTok: number;
  costOutputPerMTok: number;
  zeroCost: boolean;
  releaseDate?: number;
  source: ModelProvider | "static";
  online: boolean;
}

export interface ProviderHealth {
  provider: ModelProvider;
  label: string;
  online: boolean;
  configured: boolean;
  local: boolean;
  detail?: string;
  url?: string;
}

export interface Agent {
  id: string;
  name: string;
  handle: string;
  role: string;
  description: string;
  /** Optional explicit mesh routing tags; older persisted agents infer these from role/profile text. */
  capabilities?: string[];
  /** Optional agent skill slugs (hot-loadable from the skill registry). */
  skills?: string[];
  systemPrompt: string;
  modelKey: string;
  fallbackModelKey?: string;
  temperature: number;
  maxTokens: number;
  allowConcurrency: boolean;
  enabled: boolean;
  color: string;
  icon: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMetric {
  id: string;
  agentId: string;
  agentName: string;
  modelKey: string;
  provider: ModelProvider;
  ttftMs: number;
  totalMs: number;
  tokensPerSec: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  vramMB: number;
  queuedMs: number;
  fellBack: boolean;
  fallbackReason?: string;
  runId?: string;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  stack: "node" | "python" | "next";
  workspacePath: string;
  desktopLink?: string;
  desktopLinkError?: string;
  createdAt: number;
  updatedAt: number;
  gitInitialized: boolean;
  lastRunId?: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "recoverable_paused";

export type PhaseId =
  | "requirements"
  | "architecture"
  | "implementation"
  | "testing"
  | "deployment";

export type PhaseStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export interface PhaseLog {
  id: string;
  at: number;
  level: "info" | "warn" | "error" | "success" | "command" | "agent";
  message: string;
  detail?: string;
}

export interface HealAttempt {
  attempt: number;
  agentId: string;
  agentName: string;
  modelKey: string;
  failureSummary: string;
  appliedFiles: string[];
  result: "passed" | "failed";
  log: string;
  createdAt: number;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface PhaseState {
  id: PhaseId;
  name: string;
  description: string;
  status: PhaseStatus;
  progress: number;
  agentId?: string;
  startedAt?: number;
  completedAt?: number;
  logs: PhaseLog[];
  artifacts: string[];
  healAttempts: HealAttempt[];
  commands: CommandResult[];
  error?: string;
}

export interface GitState {
  initialized: boolean;
  branch?: string;
  baseBranch?: string;
  commits: Array<{ hash: string; message: string; at: number }>;
  dirtyFiles: number;
  remote?: string;
  pushed: boolean;
  pushError?: string;
}

export interface PullRequestState {
  url?: string;
  number?: number;
  title?: string;
  status: "skipped" | "created" | "failed" | "pending";
  error?: string;
}

export interface RunArtifacts {
  specPath?: string;
  architecturePath?: string;
  fileTree: string[];
  workflowPath?: string;
  pr?: PullRequestState;
  summary?: string;
}

export interface Run {
  id: string;
  projectId: string;
  projectName: string;
  prompt: string;
  status: RunStatus;
  currentPhase: PhaseId | null;
  phases: PhaseState[];
  git: GitState;
  artifacts: RunArtifacts;
  options: {
    maxHealAttempts: number;
    allowConcurrency: boolean;
    pushToGitHub: boolean;
    skipDeployment?: boolean;
    pipelineTopology?: CanvasTopology;
  };
  error?: string;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "event";
  content: string;
  agentId?: string;
  agentName?: string;
  agentColor?: string;
  mentions?: string[];
  metrics?: {
    modelKey: string;
    ttftMs: number;
    totalMs: number;
    tokensPerSec: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    vramMB: number;
    fellBack?: boolean;
    queuedMs?: number;
  };
  handoffFrom?: string;
  /** Guardrail score attached to the handoff that produced this message. */
  handoffScore?: number;
  /** Workspace-relative files written (or proposed) by this message. */
  artifacts?: string[];
  /** Silent Witness result for the artifacts published by this message. */
  validation?: {
    reportId: string;
    score: number;
    passed: boolean;
    findings: number;
    topFinding?: string;
  };
  runId?: string;
  createdAt: number;
  pending?: boolean;
  error?: boolean;
}

export interface ChatThread {
  id: string;
  projectId?: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface FactorySettings {
  ollamaUrl: string;
  lmstudioUrl: string;
  opencodeUrl: string;
  opencodePassword: string;
  openrouterApiKey: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  vramBudgetMB: number;
  reserveMB: number;
  maxConcurrentHeavy: number;
  maxConcurrentLight: number;
  allowConcurrentLight: boolean;
  allowCloudFallback: boolean;
  vramQueueTimeoutMs: number;
  fallbackModelKey: string;
  maxHealAttempts: number;
  commandTimeoutMs: number;
  allowExecution: boolean;
  autoCommit: boolean;
  gitAuthorName: string;
  gitAuthorEmail: string;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBaseBranch: string;
  githubCreateRepo: boolean;
  defaultAgentId: string;
  autoHandoff: boolean;
  maxHandoffDepth: number;
  guardrailThreshold: number;
  guardrailMaxRetries: number;
  deadLoopWindow: number;
  deadLoopThreshold: number;
  updatedAt: number;
}

export interface ResourceReservation {
  id: string;
  label: string;
  agentId?: string;
  agentName?: string;
  modelKey: string;
  modelName: string;
  provider: ModelProvider;
  vramMB: number;
  heavy: boolean;
  priority: number;
  enqueuedAt: number;
  startedAt?: number;
  status: "queued" | "running" | "released" | "cancelled";
  fallbackReason?: string;
}

export interface ResourceSnapshot {
  budgetMB: number;
  reserveMB: number;
  usedMB: number;
  availableMB: number;
  running: ResourceReservation[];
  queued: ResourceReservation[];
  history: ResourceReservation[];
  heavyRunning: number;
  maxConcurrentHeavy: number;
  allowConcurrentLight: boolean;
  updatedAt: number;
}

export type GuardrailCheckLevel = "pass" | "warn" | "fail";

export interface GuardrailCheck {
  id: string;
  label: string;
  level: GuardrailCheckLevel;
  score: number;
  detail: string;
}

export interface HandoffTraceStep {
  sourceAgent: string;
  targetAgent: string;
  payloadHash: string;
  at: number;
  progressed: boolean;
}

export interface DeadLoopInfo {
  detected: boolean;
  transition: string;
  occurrences: number;
  window: HandoffTraceStep[];
  message: string;
}

export interface GuardrailResult {
  id: string;
  sourceAgent: string;
  targetAgent: string;
  score: number;
  passed: boolean;
  threshold: number;
  checks: GuardrailCheck[];
  errors: string[];
  payloadHash: string;
  retryCount: number;
  deadLoop: DeadLoopInfo;
  createdAt: number;
}

export type CanvasNodeKind = "agent" | "validator" | "router";

export interface CanvasNodeData {
  label: string;
  kind: CanvasNodeKind;
  agentId?: string;
  modelKey?: string;
  provider?: ModelProvider;
  prompt?: string;
  assertion?: string;
  condition?: string;
  status?: "idle" | "queued" | "running" | "passed" | "failed" | "blocked";
  detail?: string;
  guardrailScore?: number;
  /** Wall-clock execution time for the last DAG run. */
  durationMs?: number;
  /** Tokens emit/consumed by the node's last model call. */
  tokens?: number;
  /** Last error returned by the node, kept for the inspector. */
  error?: string;
  /** Short preview of the node output, rendered in the inspector. */
  outputPreview?: string;
}

export interface CanvasTopology {
  version: 1;
  nodes: Array<{
    id: string;
    type: CanvasNodeKind;
    position: { x: number; y: number };
    data: CanvasNodeData;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
    animated?: boolean;
  }>;
  updatedAt: number;
}

export interface FactoryDb {
  version: number;
  agents: Agent[];
  projects: Project[];
  runs: Run[];
  metrics: AgentMetric[];
  threads: ChatThread[];
  settings: FactorySettings;
  /** Last saved DAG in the canvas editor. */
  canvasTopology?: CanvasTopology | null;
  /** DAG used by autonomous runs, the run launcher and chat. */
  activeTopology?: CanvasTopology | null;
  createdAt: number;
  updatedAt: number;
}

export type ResourceEvent = {
  type: "resource";
  snapshot: ResourceSnapshot;
};

export type RunEvent =
  | { type: "snapshot"; run: Run }
  | { type: "phase"; runId: string; phase: PhaseState }
  | { type: "log"; runId: string; phaseId: PhaseId; log: PhaseLog }
  | { type: "status"; runId: string; status: RunStatus; currentPhase: PhaseId | null }
  | { type: "heal"; runId: string; attempt: HealAttempt }
  | { type: "guardrail"; runId: string; result: GuardrailResult }
  | { type: "dead_loop"; runId: string; deadLoop: DeadLoopInfo }
  | { type: "artifact"; runId: string; artifacts: RunArtifacts }
  | { type: "done"; runId: string; status: RunStatus }
  | { type: "error"; runId: string; message: string };

export type MeshEventType =
  | "ARTIFACT_CREATED"
  | "TEST_FAILED"
  | "SCHEMA_UPDATED"
  | "SECURITY_WARNING"
  | "VALIDATION_STARTED"
  | "VALIDATION_PASSED"
  | "VALIDATION_FAILED"
  | "VALIDATION_OVERRIDDEN"
  | "AGENT_STATUS"
  | "HANDOFF"
  | "AGENT_ENVELOPE"
  | "ROUTING_ERROR"
  | "TASK_CONTRACT"
  | "PRE_FLIGHT_BLOCKED"
  | "POST_FLIGHT_PASSED"
  | "POST_FLIGHT_BLOCKED"
  | "SCOPE_ADVISORY"
  | "TERMINAL_OUTPUT"
  | "MEMORY_CONSTRAINT"
  | "AUTOMATION_STARTED"
  | "AUTOMATION_PASSED"
  | "AUTOMATION_FAILED"
  | "CANVAS_RUN_STARTED"
  | "CANVAS_RUN_COMPLETED"
  | "NEGOTIATION_STARTED"
  | "NEGOTIATION_MESSAGE"
  | "NEGOTIATION_RESOLVED"
  | "NEGOTIATION_FAILED";

export type MeshSeverity = "info" | "success" | "warning" | "error";

export type MeshAgentStatus =
  | "idle"
  | "thinking"
  | "communicating"
  | "validating"
  | "executing"
  | "paused"
  | "error";

export interface MeshEvent {
  id: string;
  /** Monotonic bus sequence, used for SSE resume and client-side dedupe. */
  sequence?: number;
  type: MeshEventType;
  at: number;
  source: string;
  target?: string;
  agentId?: string;
  targetAgentId?: string;
  threadId?: string;
  projectId?: string;
  runId?: string;
  severity: MeshSeverity;
  title: string;
  message: string;
  payload?: Record<string, unknown>;
  requiresOverride?: boolean;
}

export interface AgentConstraint {
  id: string;
  agentId: string;
  rule: string;
  source: "validator" | "error" | "guardrail" | "dead-loop" | "negotiation" | "manual";
  evidence?: string;
  createdAt: number;
  hits: number;
}

export interface AgentHandoffMemory {
  id: string;
  agentId: string;
  taskId: string;
  /** Three-sentence semantic summary retained after scratchpad contents expire. */
  summary: string;
  /** Workspace-relative file pointers, never raw file contents. */
  modifiedFiles: string[];
  createdAt: number;
}

export interface AgentMemory {
  agentId: string;
  constraints: AgentConstraint[];
  /** Long-term, pointer-only handoff history. Raw scratchpads are never stored here. */
  handoffs?: AgentHandoffMemory[];
  updatedAt: number;
}

export interface AgentAnalytics {
  agentId: string;
  name: string;
  handle: string;
  enabled: boolean;
  tasksAssigned: number;
  accepted: number;
  rejected: number;
  blocked: number;
  acceptanceRate: number;
  postFlightPassed: number;
  postFlightFailed: number;
  postFlightAttempts: number;
  firstPasses: number;
  firstPassRate: number;
  tokensConsumed: number;
  artifactFiles: number;
  artifactBytes: number;
  artifactPaths: string[];
  lastActivityAt: number;
}

export interface MeshAgentState {
  agentId: string;
  status: MeshAgentStatus;
  detail?: string;
  updatedAt: number;
}

export interface ValidationFinding {
  id: string;
  severity: "info" | "warning" | "error";
  code: string;
  title: string;
  detail: string;
  suggestion: string;
  path?: string;
}

export interface ValidationReport {
  id: string;
  agentId?: string;
  threadId?: string;
  projectId?: string;
  runId?: string;
  score: number;
  passed: boolean;
  witnessModel?: string;
  findings: ValidationFinding[];
  durationMs: number;
  createdAt: number;
}

/** Structured pointer-based handoff attached to the outgoing agent envelope. */
export interface HandoffSummary {
  /** Exactly three sentences describing the completed work. */
  summary: string;
  modifiedFiles: string[];
  verifiedArtifacts: number;
  findings: number;
}

export interface NegotiationMessage {
  id: string;
  negotiationId: string;
  round: number;
  fromAgent: string;
  fromAgentId: string;
  toAgent: string;
  content: string;
  createdAt: number;
}

export interface MeshControlSnapshot {
  pausedAgentIds: string[];
  overriddenEventIds: string[];
  updatedAt: number;
}

export interface ChatStreamEvent {
  type:
    | "start"
    | "token"
    | "agent"
    | "metrics"
    | "handoff"
    | "routing"
    | "guardrail"
    | "dead_loop"
    | "message"
    | "artifact"
    | "validation"
    | "run"
    | "error"
    | "done";
  data: unknown;
}
