import { describe, it, expect } from "vitest";
import { agentCapabilities } from "@/lib/mesh/accountability";
import type { Agent } from "@/lib/core/types";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-test",
    name: "Test Agent",
    handle: "test",
    role: "Specialist",
    description: "A focused specialist.",
    systemPrompt: "Follow the task.",
    modelKey: "local/default",
    temperature: 0.2,
    maxTokens: 2_000,
    allowConcurrency: false,
    enabled: true,
    color: "#888888",
    icon: "bot",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("agentCapabilities", () => {
  it("ignores domains that only appear in the system prompt", () => {
    const capabilities = agentCapabilities(
      agent({
        name: "Lin",
        handle: "dev",
        role: "Frontend Engineer",
        description: "Builds React interfaces.",
        capabilities: ["frontend/ui/react"],
        systemPrompt:
          "You own security auditing, performance tuning, database schemas, CI/CD deployment, release notes and test fixtures. Always consider every domain before writing code.",
      }),
    );

    expect(capabilities).toContain("frontend/ui/react");
    expect(capabilities).not.toContain("security/audit");
    expect(capabilities).not.toContain("devops/platform");
    expect(capabilities).not.toContain("qa/testing");
    expect(capabilities).not.toContain("architecture/design");
  });

  it("honors declared capabilities and short identity fields", () => {
    const capabilities = agentCapabilities(
      agent({
        name: "Sentry",
        handle: "security",
        role: "Security Reviewer",
        description: "Audits auth and data handling.",
        capabilities: ["security/audit"],
      }),
    );

    expect(capabilities).toContain("security/audit");
    expect(capabilities).toContain("backend/api/data");
  });

  it("keeps a generalist developer qualified for both implementation domains", () => {
    const capabilities = agentCapabilities(
      agent({ name: "Ada", handle: "dev", role: "Full-stack Developer", capabilities: [] }),
    );

    expect(capabilities).toContain("frontend/ui/react");
    expect(capabilities).toContain("backend/api/data");
  });
});
