import fs from "node:fs";
import path from "node:path";

/**
 * Agent Skill Registry — hot-loadable skills for factory agents.
 *
 * Mirrors the tool registry pattern: skills are defined by JSON schemas and
 * can be assigned to agents without recompiling. A skill bundles a name,
 * description, prompt snippet, and optional tool dependencies.
 */

export interface AgentSkill {
  slug: string;
  name: string;
  description: string;
  promptSnippet: string;
  tools?: string[];
  category: "code" | "review" | "testing" | "docs" | "ops" | "general";
  registeredAt: number;
}

const registry = new Map<string, AgentSkill>();

export function registerSkill(skill: Omit<AgentSkill, "registeredAt"> & { registeredAt?: number }): AgentSkill {
  const full: AgentSkill = { ...skill, registeredAt: skill.registeredAt ?? Date.now() };
  registry.set(full.slug, full);
  return full;
}

export function unregisterSkill(slug: string): boolean {
  return registry.delete(slug);
}

export function getSkill(slug: string): AgentSkill | undefined {
  return registry.get(slug);
}

export function listSkills(): AgentSkill[] {
  return Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsForAgent(slugs: string[] | undefined): AgentSkill[] {
  if (!slugs?.length) return [];
  return slugs.map((s) => registry.get(s)).filter((s): s is AgentSkill => Boolean(s));
}

export function loadSkillsFromDirectory(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const parsed = JSON.parse(raw) as Omit<AgentSkill, "registeredAt">;
      if (parsed.slug && parsed.name) {
        registerSkill(parsed);
        count++;
      }
    } catch {
      // skip malformed
    }
  }
  return count;
}

// Built-in skills
const builtins: Array<Omit<AgentSkill, "registeredAt">> = [
  {
    slug: "code-review",
    name: "Code Review",
    description: "Review code for correctness, style, and security issues.",
    promptSnippet: "When reviewing code, check for correctness, edge cases, security vulnerabilities, and adherence to project conventions. Report findings with severity and concrete fix suggestions.",
    tools: ["json-validator"],
    category: "review",
  },
  {
    slug: "security-audit",
    name: "Security Audit",
    description: "Audit code for OWASP top-10 vulnerabilities and secret leakage.",
    promptSnippet: "Audit for injection, XSS, SSRF, hardcoded secrets, insecure deserialization, and broken access control. Flag any dynamic exec or unsanitized HTML.",
    tools: ["json-validator"],
    category: "review",
  },
  {
    slug: "test-generation",
    name: "Test Generation",
    description: "Generate comprehensive unit and integration tests.",
    promptSnippet: "Generate tests covering happy paths, edge cases, and error conditions. Use the project's existing test framework and conventions.",
    tools: [],
    category: "testing",
  },
  {
    slug: "performance-optimize",
    name: "Performance Optimization",
    description: "Identify and fix performance bottlenecks.",
    promptSnippet: "Profile for unnecessary re-renders, N+1 queries, large bundle sizes, and blocking I/O. Propose concrete optimizations with expected impact.",
    tools: ["tailwind-class-optimizer"],
    category: "code",
  },
  {
    slug: "docs-generation",
    name: "Documentation Generation",
    description: "Generate README, API docs, and inline documentation.",
    promptSnippet: "Generate clear, concise documentation including setup instructions, API reference, and usage examples. Match the project's documentation style.",
    tools: [],
    category: "docs",
  },
  {
    slug: "devops-deploy",
    name: "DevOps & Deployment",
    description: "Handle CI/CD, Docker, and deployment configuration.",
    promptSnippet: "Configure build pipelines, Docker images, and deployment manifests. Ensure reproducible builds and proper secret management.",
    tools: [],
    category: "ops",
  },
];

for (const skill of builtins) registerSkill(skill);