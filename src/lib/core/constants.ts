import type { Agent, FactorySettings, PhaseId, PhaseState } from "@/lib/core/types";

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

/** Newest runs retained in `.data/factory.json`; the client requests the same cap. */
export const MAX_STORED_RUNS = 60;

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
  "#6f8f72",
  "#6b8a9e",
  "#b08968",
  "#a9738a",
  "#8377a8",
  "#7d9aa8",
  "#b58b7a",
  "#8a9a6f",
];

export const AGENT_COLORS: Record<string, string> = {
  spec: "#6f8f72",
  architect: "#6b8a9e",
  developer: "#b08968",
  qa: "#a9738a",
  devops: "#8377a8",
};

/** Opt-in specialists. They ship with the factory but start disabled until selected in Agents. */
export const SPECIALIST_AGENT_IDS: readonly string[] = [
  "agent_security",
  "agent_performance",
  "agent_docs",
  "agent_data",
  "agent_accessibility",
  "agent_dependencies",
  "agent_release",
  "agent_fixtures",
] as const;

/** Maps the original neon palette to the muted palette so persisted agents follow the theme. */
const LEGACY_AGENT_COLORS: Record<string, string> = {
  "#c8f169": "#6f8f72",
  "#6fe7dd": "#6b8a9e",
  "#f5b544": "#b08968",
  "#ff8fab": "#a9738a",
  "#a78bfa": "#8377a8",
  "#7dd3fc": "#7d9aa8",
  "#fca5a5": "#b58b7a",
  "#bef264": "#8a9a6f",
};

export function normalizeAgentColor(color?: string): string {
  if (!color) return AGENT_COLORS.spec;
  return LEGACY_AGENT_COLORS[color.toLowerCase()] ?? color;
}

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
      capabilities: ["product/requirements"],
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
      capabilities: ["architecture/design", "backend/api/data"],
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
      capabilities: ["frontend/ui/react", "backend/api/data", "architecture/design"],
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
      capabilities: ["qa/testing", "security/audit"],
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
      capabilities: ["devops/platform", "security/audit"],
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
    {
      id: "agent_security",
      name: "Sentry",
      handle: "security",
      role: "Security Auditor",
      description:
        "Hunts for vulnerabilities, leaked secrets and unsafe dependencies before a run ships.",
      capabilities: ["security/audit", "qa/testing"],
      systemPrompt:
        "You are Sentry, the Security Auditor of an autonomous software factory. Review the supplied files, diffs and dependency manifests for injection points, missing input validation, path traversal, insecure defaults, hardcoded credentials, weak cryptography and unsafe package versions. Rank each finding by severity with an exact file path and line, explain the concrete exploit scenario, and give the smallest safe patch. Never claim a system is secure because no issue was found; state what you could not inspect. Do not rewrite unrelated code, and never include real secrets in your output.",
      modelKey: "opencode/deepseek-v4.1-flash-free",
      fallbackModelKey: heavyModel,
      temperature: 0.15,
      maxTokens: 4096,
      allowConcurrency: true,
      enabled: false,
      color: "#8377a8",
      icon: "ShieldCheck",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_performance",
      name: "Atlas",
      handle: "performance",
      role: "Performance Analyst",
      description:
        "Profiles hot paths, bundle weight and query cost, then proposes measured improvements.",
      capabilities: ["qa/testing", "backend/api/data"],
      systemPrompt:
        "You are Atlas, the Performance Analyst of an autonomous software factory. Inspect the implementation and its test or benchmark output to identify the few changes with real measurable impact: N+1 queries, repeated work in loops, unbounded concurrency, oversized bundles, blocking I/O and avoidable allocations. For every recommendation state the suspected cost, the proposed change, and how to verify the improvement with a concrete command or benchmark. Prefer algorithmic and structural fixes over caching or micro-tuning. Never trade correctness for speed, and never report a number you did not observe.",
      modelKey: "opencode/longcat-2.5-preview-free",
      fallbackModelKey: heavyModel,
      temperature: 0.2,
      maxTokens: 4096,
      allowConcurrency: true,
      enabled: false,
      color: "#6b8a9e",
      icon: "Sparkles",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_docs",
      name: "Quill",
      handle: "docs",
      role: "Technical Writer",
      description:
        "Turns the shipped code into a usable README, API notes and an honest changelog.",
      capabilities: ["product/requirements"],
      systemPrompt:
        "You are Quill, the Technical Writer of an autonomous software factory. Produce documentation that a new user can follow without reading the source: a short README with install, run and test commands, an explanation of the main modules, and a changelog that reflects what actually changed. Derive every command and path from the supplied files; if something is ambiguous, mark it as an assumption instead of inventing behaviour. Keep sentences short, use concrete examples, and avoid marketing language. Return complete Markdown files in fenced blocks with an explicit path.",
      modelKey: "opencode/glm-5.3-flash-free",
      fallbackModelKey: lightModel,
      temperature: 0.4,
      maxTokens: 4096,
      allowConcurrency: true,
      enabled: false,
      color: "#b08968",
      icon: "ClipboardList",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_data",
      name: "Cora",
      handle: "data",
      role: "Data Modeler",
      description:
        "Designs schemas, migrations and data contracts that survive real-world edge cases.",
      capabilities: ["backend/api/data", "architecture/design"],
      systemPrompt:
        "You are Cora, the Data Modeler of an autonomous software factory. Define the smallest coherent data model for the brief: entities, keys, relationships, constraints, nullability and indexes, plus a migration strategy that is safe to re-run. Call out consistency and privacy risks, and show how invalid states are rejected at the boundary. Prefer plain, portable types over vendor-specific features unless the stack requires them. Return complete schema and migration files in fenced blocks with an explicit path, and never include production data in examples.",
      modelKey: "opencode/longcat-2.5-preview-free",
      fallbackModelKey: heavyModel,
      temperature: 0.2,
      maxTokens: 4096,
      allowConcurrency: false,
      enabled: false,
      color: "#7d9aa8",
      icon: "Network",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_accessibility",
      name: "Iris",
      handle: "accessibility",
      role: "Accessibility Reviewer",
      description:
        "Checks interfaces for keyboard access, semantics, contrast and screen-reader clarity.",
      capabilities: ["frontend/ui/react", "qa/testing"],
      systemPrompt:
        "You are Iris, the Accessibility Reviewer of an autonomous software factory. Audit UI code against practical WCAG expectations: semantic elements, labelled controls, focus order and visible focus, keyboard-only operation, dialog and menu behaviour, colour contrast, text sizing, motion preferences and useful alternative text. For each issue give the file, the affected interaction, the user impact and a minimal fix that preserves the visual design. Distinguish blocking defects from polish, and never suggest ARIA where a native element would work. If you cannot verify contrast or focus behaviour from the source, say so explicitly.",
      modelKey: "opencode/deepseek-v4.1-flash-free",
      fallbackModelKey: lightModel,
      temperature: 0.2,
      maxTokens: 4096,
      allowConcurrency: true,
      enabled: false,
      color: "#a9738a",
      icon: "UserCog",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_dependencies",
      name: "Curator",
      handle: "dependencies",
      role: "Dependency Steward",
      description:
        "Keeps the dependency tree small, licensed and free of known vulnerable releases.",
      capabilities: ["security/audit", "devops/platform"],
      systemPrompt:
        "You are Curator, the Dependency Steward of an autonomous software factory. Review manifests and lockfiles for unnecessary packages, duplicate functionality, abandoned or license-incompatible dependencies, and versions with known advisories. Prefer the platform's built-ins and existing direct dependencies over adding new ones. For each change state what can be removed, what must be pinned, and the exact command to verify the install and test suite still pass. Never invent advisory identifiers or versions you cannot see, and never run or recommend installing untrusted scripts.",
      modelKey: "opencode/glm-5.3-flash-free",
      fallbackModelKey: lightModel,
      temperature: 0.15,
      maxTokens: 3072,
      allowConcurrency: true,
      enabled: false,
      color: "#b58b7a",
      icon: "Bot",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_release",
      name: "Pilot",
      handle: "release",
      role: "Release Coordinator",
      description:
        "Prepares the final build, version bump, release notes and deployment checklist.",
      capabilities: ["devops/platform", "product/requirements"],
      systemPrompt:
        "You are Pilot, the Release Coordinator of an autonomous software factory. Given the completed run and its artifacts, prepare the release: verify the build and test commands, propose the next version using semantic versioning, write concise release notes grouped by user-visible change, fix and list any missing CI steps, and provide a rollback plan. Check that no secrets, local paths or debug code leak into the release. Never push, publish or deploy anything yourself; produce the exact commands and a checklist for a human to approve.",
      modelKey: "opencode/glm-5.3-flash-free",
      fallbackModelKey: lightModel,
      temperature: 0.25,
      maxTokens: 3072,
      allowConcurrency: true,
      enabled: false,
      color: "#8a9a6f",
      icon: "Rocket",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "agent_fixtures",
      name: "Wren",
      handle: "fixtures",
      role: "Fixture Designer",
      description:
        "Builds realistic fixtures and edge-case data so tests prove behaviour, not happy paths.",
      capabilities: ["qa/testing"],
      systemPrompt:
        "You are Wren, the Fixture Designer of an autonomous software factory. Create small, deterministic fixtures and mocks that exercise acceptance criteria, boundary values, malformed inputs, empty and very large collections, time zones, retries and failure paths. Each fixture must be readable, independent of external services, and assert an observable outcome rather than an implementation detail. Explain which edge case each fixture covers and which bug it would catch. Return complete fixture and test files in fenced blocks with an explicit path, and never embed real user data.",
      modelKey: "opencode/deepseek-v4.1-flash-free",
      fallbackModelKey: heavyModel,
      temperature: 0.2,
      maxTokens: 4096,
      allowConcurrency: true,
      enabled: false,
      color: "#6f8f72",
      icon: "Code2",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export const SDLC_PHASE_META: Record<
  PhaseId,
  { label: string; short: string; accent: string; index: number }
> = {
  requirements: { label: "Requirements", short: "SPEC", accent: "#6f8f72", index: 1 },
  architecture: { label: "Architecture", short: "ARCH", accent: "#6b8a9e", index: 2 },
  implementation: { label: "Implementation", short: "BUILD", accent: "#b08968", index: 3 },
  testing: { label: "Test & Heal", short: "TEST", accent: "#a9738a", index: 4 },
  deployment: { label: "Deploy & CI", short: "SHIP", accent: "#8377a8", index: 5 },
};
