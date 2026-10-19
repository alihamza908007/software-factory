export type ModelProvider = "ollama" | "opencode" | "openai";

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
  source: "ollama" | "opencode" | "static";
  online: boolean;
}

export interface Agent {
  id: string;
  name: string;
  handle: string;
  role: string;
  description: string;
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
  | "interrupted";

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
  };
  handoffFrom?: string;
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
  opencodeUrl: string;
  opencodePassword: string;
  vramBudgetMB: number;
  reserveMB: number;
  maxConcurrentHeavy: number;
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

export interface FactoryDb {
  version: number;
  agents: Agent[];
  projects: Project[];
  runs: Run[];
  metrics: AgentMetric[];
  threads: ChatThread[];
  settings: FactorySettings;
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
  | { type: "artifact"; runId: string; artifacts: RunArtifacts }
  | { type: "done"; runId: string; status: RunStatus }
  | { type: "error"; runId: string; message: string };

export interface ChatStreamEvent {
  type:
    | "start"
    | "token"
    | "agent"
    | "metrics"
    | "handoff"
    | "message"
    | "run"
    | "error"
    | "done";
  data: unknown;
}
