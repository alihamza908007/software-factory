import { describe, it, expect } from "vitest";
import { assertAgentFields } from "@/lib/data/agent-input";

describe("agent input validation", () => {
  it("accepts a complete editable profile", () => {
    expect(() =>
      assertAgentFields({
        name: "Sable",
        role: "Security Reviewer",
        handle: "sable",
        modelKey: "ollama/qwen3:8b",
        temperature: 0.3,
        maxTokens: 4096,
        capabilities: ["security", "review"],
        skills: ["owasp"],
      }),
    ).not.toThrow();
  });

  it("rejects blank required text", () => {
    expect(() => assertAgentFields({ name: "   " })).toThrow(/name cannot be empty/i);
    expect(() => assertAgentFields({ role: "" })).toThrow(/role cannot be empty/i);
    expect(() => assertAgentFields({ systemPrompt: "" })).toThrow(/system prompt cannot be empty/i);
  });

  it("rejects out-of-range sampling settings", () => {
    expect(() => assertAgentFields({ temperature: 3 })).toThrow(/temperature/i);
    expect(() => assertAgentFields({ temperature: Number.NaN })).toThrow(/temperature/i);
    expect(() => assertAgentFields({ maxTokens: 100 })).toThrow(/tokens/i);
    expect(() => assertAgentFields({ maxTokens: 4096.5 })).toThrow(/tokens/i);
  });

  it("normalizes capability and skill tags", () => {
    const body = { capabilities: ["  security  ", "review"], skills: [" owasp "] };
    assertAgentFields(body);
    expect(body.capabilities).toEqual(["security", "review"]);
    expect(body.skills).toEqual(["owasp"]);
  });

  it("rejects empty or oversized tags", () => {
    expect(() => assertAgentFields({ capabilities: [""] })).toThrow(/capabilities/i);
    expect(() => assertAgentFields({ skills: ["x".repeat(65)] })).toThrow(/skills/i);
  });
});
