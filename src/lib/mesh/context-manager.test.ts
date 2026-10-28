import { describe, it, expect } from "vitest";
import { compactAgentContext, compactConversationHistory } from "./context-manager";
import { sanitizeFtsQuery } from "./vector-memory";

describe("compactAgentContext", () => {
  it("preserves code when input is within maxChars limit", () => {
    const input = [
      "Here is the greeting helper:",
      "",
      "```typescript path=src/greet.ts",
      "export function greet(name: string): string {",
      "  return `Hello, ${name}!`;",
      "}",
      "```",
    ].join("\n");

    const result = compactAgentContext(input, 2_000);
    expect(result.text).toContain("export function greet");
    expect(result.artifactPointers).toEqual(["src/greet.ts"]);
  });

  it("extracts signatures and declarations when content exceeds maxChars", () => {
    const longContent = "const a = 1;\n".repeat(300);
    const input = [
      "Implemented auth router with token refresh logic.",
      "",
      "```typescript path=src/auth.ts",
      "export interface TokenPayload { id: string; role: string; }",
      "export async function verifyToken(token: string): Promise<TokenPayload> {",
      "  return { id: '1', role: 'admin' };",
      "}",
      longContent,
      "```",
    ].join("\n");

    const result = compactAgentContext(input, 500);
    expect(result.artifactPointers).toContain("src/auth.ts");
    expect(result.text).toContain("export async function verifyToken");
    expect(result.text.length).toBeLessThanOrEqual(500);
  });
});

describe("compactConversationHistory", () => {
  it("retains recent assistant message code intact so agents don't suffer amnesia", () => {
    const history = [
      { role: "user" as const, content: "Build a greeter function" },
      {
        role: "assistant" as const,
        agentName: "Lin",
        content: "```typescript path=src/greet.ts\nexport function greet() { return 'hello'; }\n```",
      },
    ];

    const compacted = compactConversationHistory(history);
    expect(compacted[1].content).toContain("export function greet");
  });
});

describe("sanitizeFtsQuery", () => {
  it("escapes syntax-breaking punctuation like parentheses, colons, and operators", () => {
    expect(sanitizeFtsQuery("function()")).toContain('"function"*');
    expect(sanitizeFtsQuery("user:auth")).toContain('"user"*');
    expect(sanitizeFtsQuery("test-runner")).toContain('"test"*');
  });

  it("handles empty query strings safely without crashing", () => {
    expect(sanitizeFtsQuery("   ")).toBe('""');
    expect(sanitizeFtsQuery("!@#$%^&*()")).toBe('""');
  });
});
