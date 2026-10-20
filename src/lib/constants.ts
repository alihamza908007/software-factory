import type { Agent, FactorySettings, PhaseId, PhaseState } from "./types";

export const PHASES: Array<{
  id: PhaseId;
  name: string;
  short: string;
  description: string;
  agentRole: string;
}> = [
  {
    id: "requirements",
    name: "Requirements & Spec",
    short: "SPEC",
    description:
      "Turn the brief into an unambiguous product specification with acceptance criteria.",
    agentRole: "Product Manager",
  },
  {
    id: "architecture",
    name: "Architecture & File Tree",
    short: "ARCH",
    description:
      "Design the system, interfaces, risks and the exact file tree to be built.",
    agentRole: "Architect",
  },
  {
    id: "implementation",
    name: "Implementation",
    short: "BUILD",
    description:
      "Compile a working implementation from the spec and architecture inside the workspace.",
    agentRole: "Developer",
  },
  {
    id: "testing",
    name: "Test, Lint & Self-Heal",
    short: "TEST",
    description:
      "Generate tests, execute the local toolchain and loop failures back to the developer.",
    agentRole: "QA Engineer",
  },
  {
    id: "deployment",
    name: "Deployment & CI",
    short: "SHIP",
    description:
      "Generate CI/CD, verify the build, commit a feature branch and prepare a pull request.",
    agentRole: "DevOps",
  },
];

export const PHASE_IDS = PHASES.map((phase) => phase.id);

export function createPhases(): PhaseState[] {
  return PHASES.map((phase) => ({
    id: phase.id,
    name: phase.name,
    description: phase.description,
    status: "pending",
    progress: 0,
    logs: [],
    artifacts: [],
    healAttempts: [],
    commands: [],
  }));
}

export const DEFAULT_SETTINGS: FactorySettings = {
  ollamaUrl: "http://127.0.0.1:11434",
  lmstudioUrl: "http://127.0.0.1:1234/v1",
  opencodeUrl: "",
  opencodePassword: "",
  openrouterApiKey: "",
  anthropicApiKey: "",
  openaiApiKey: "",
  geminiApiKey: "",
  vramBudgetMB: 36864,
  reserveMB: 8192,
  maxConcurrentHeavy: 1,
  maxConcurrentLight: 2,
  allowConcurrentLight: true,
  allowCloudFallback: true,
  vramQueueTimeoutMs: 90_000,
  fallbackModelKey: "opencode/deepseek-v4.1-flash-free",
  maxHealAttempts: 3,
  commandTimeoutMs: 120_000,
  allowExecution: true,
  autoCommit: true,
  gitAuthorName: "Software Factory",
  gitAuthorEmail: "factory@localhost",
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBaseBranch: "main",
  githubCreateRepo: false,
  defaultAgentId: "",
  autoHandoff: true,
  maxHandoffDepth: 2,
  guardrailThreshold: 70,
  guardrailMaxRetries: 2,
  deadLoopWindow: 5,
  deadLoopThreshold: 3,
  updatedAt: 0,
};

export const AGENT_PALETTE = [
  "#c8f169",
  "#6fe7dd",
  "#f5b544",
  "#ff8fab",
  "#a78bfa",
  "#7dd3fc",
  "#fca5a5",
  "#bef264",
];

export const AGENT_COLORS: Record<string, string> = {
  spec: "#c8f169",
  architect: "#6fe7dd",
  developer: "#f5b544",
  qa: "#ff8fab",
  devops: "#a78bfa",
};

export function defaultAgents(heavyModel: string, lightModel: string): Agent[] {
  const now = Date.now();
  return [
    {
      id: "agent_product",
      name: "Morgan",
      handle: "product",
      role: "Product Manager",
      description:
        "Turns fuzzy ideas into crisp specs, acceptance criteria and scope boundaries.",
      systemPrompt:
        "You are Morgan, the Product Manager of an autonomous software factory. You convert user briefs into precise, buildable specifications. You are decisive, scope-aware and write acceptance criteria that a QA engineer can test directly. Never invent requirements that contradict the brief; state assumptions explicitly.",
      modelKey: "opencode/deepseek-v4.1-flash-free",
      fallbackModelKey: heavyModel,
      temperature: 0.4,
      maxTokens: 4096,
      allowConcurrency: true,
      enabled: true,
      color: AGENT_COLORS.spec,
      icon: "ClipboardList",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_architect",
      name: "Ada",
      handle: "architect",
      role: "Systems Architect",
      description:
        "Maps the system, interfaces, risks and exact file tree before code is written.",
      systemPrompt:
        "You are Ada, the Systems Architect. You design small, robust systems that can be implemented and tested in a single local workspace. You prefer boring, dependency-light solutions. You produce explicit file trees, module boundaries, data shapes and failure modes. You never write implementation code in the architecture phase.",
      modelKey: "opencode/longcat-2.5-preview-free",
      fallbackModelKey: heavyModel,
      temperature: 0.35,
      maxTokens: 4096,
      allowConcurrency: true,
      enabled: true,
      color: AGENT_COLORS.architect,
      icon: "Network",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_developer",
      name: "Lin",
      handle: "developer",
      role: "Developer",
      description:
        "Implements the plan locally, file by file, and repairs failures from logs.",
      systemPrompt:
        "You are Lin, a senior full-stack developer. You implement exactly what the spec and architecture require, producing complete runnable files. You favor dependency-light JavaScript and Node's built-in test runner unless the project stack says otherwise. When given test failures, you diagnose the root cause and patch the smallest correct surface. You always return complete file contents in fenced blocks with an explicit path.",
      modelKey: heavyModel,
      fallbackModelKey: "opencode/deepseek-v4.1-flash-free",
      temperature: 0.15,
      maxTokens: 8192,
      allowConcurrency: false,
      enabled: true,
      color: AGENT_COLORS.developer,
      icon: "Code2",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_qa",
      name: "Vera",
      handle: "qa",
      role: "QA Engineer",
      description:
        "Writes adversarial tests, runs the toolchain and feeds failures back to development.",
      systemPrompt:
        "You are Vera, the QA Engineer. You write tests that verify the acceptance criteria, including edge cases and failure paths. You run the local test and lint commands, read the raw output carefully, and summarise failures precisely. You never hide a failing test. You always return complete test files in fenced blocks with an explicit path.",
      modelKey: "opencode/deepseek-v4.1-flash-free",
      fallbackModelKey: "opencode/longcat-2.5-preview-free",
      temperature: 0.2,
      maxTokens: 8192,
      allowConcurrency: true,
      enabled: true,
      color: AGENT_COLORS.qa,
      icon: "ShieldCheck",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_devops",
      name: "Deacon",
      handle: "devops",
      role: "DevOps",
      description:
        "Owns CI/CD, branch hygiene, semantic commits, deployment checks and pull requests.",
      systemPrompt:
        "You are Deacon, the DevOps engineer. You generate minimal, correct GitHub Actions workflows, verify builds, write semantic commit messages and prepare clear pull request summaries. You never commit secrets. You prefer deterministic commands and explicit permissions.",
      modelKey: "opencode/glm-5.3-flash-free",
      fallbackModelKey: lightModel,
      temperature: 0.25,
      maxTokens: 3072,
      allowConcurrency: true,
      enabled: true,
      color: AGENT_COLORS.devops,
      icon: "Rocket",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export const SDLC_PHASE_META: Record<
  PhaseId,
  { label: string; short: string; accent: string; index: number }
> = {
  requirements: { label: "Requirements", short: "SPEC", accent: "#c8f169", index: 1 },
  architecture: { label: "Architecture", short: "ARCH", accent: "#6fe7dd", index: 2 },
  implementation: { label: "Implementation", short: "BUILD", accent: "#f5b544", index: 3 },
  testing: { label: "Test & Heal", short: "TEST", accent: "#ff8fab", index: 4 },
  deployment: { label: "Deploy & CI", short: "SHIP", accent: "#a78bfa", index: 5 },
};
