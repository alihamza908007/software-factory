import { describe, it, expect } from "vitest";
import { classifyHandoff, resetGuardrailTrace } from "./guardrails";
import type { GuardrailAgent } from "./guardrails";

const source: GuardrailAgent = {
  id: "src",
  name: "Developer",
  handle: "developer",
  role: "Developer",
};

const target: GuardrailAgent = {
  id: "tgt",
  name: "QA",
  handle: "qa",
  role: "QA Tester",
};

describe("classifyHandoff", () => {
  it("passes a substantive, structured handoff with file blocks", () => {
    const payload = [
      "## Summary",
      "Implemented the feature with two files.",
      "",
      "```typescript path=src/foo.ts",
      "export const x = 1;",
      "```",
      "```typescript path=src/foo.test.ts",
      "test('x', () => expect(x).toBe(1));",
      "```",
      "",
      "- Handles edge cases",
      "- Adds tests",
    ].join("\n");
    const result = classifyHandoff({
      sourceAgent: source,
      targetAgent: target,
      payload,
      originalRequest: "add feature",
      traceKey: "test-trace-1",
      stage: "implementation",
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.deadLoop.detected).toBe(false);
  });

  it("fails an empty payload", () => {
    const result = classifyHandoff({
      sourceAgent: source,
      targetAgent: target,
      payload: "",
      originalRequest: "add feature",
      traceKey: "test-trace-2",
      stage: "implementation",
    });
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("detects a dead loop on repeated identical payloads", () => {
    const traceKey = "dead-loop-trace";
    resetGuardrailTrace(traceKey);
    const payload = "## Handoff\n\n- item\n\n```ts path=a.ts\nx\n```".repeat(1);
    // threshold default 3; send the same transition 3 times
    for (let i = 0; i < 2; i++) {
      classifyHandoff({ sourceAgent: source, targetAgent: target, payload, traceKey, stage: "chat" });
    }
    const third = classifyHandoff({ sourceAgent: source, targetAgent: target, payload, traceKey, stage: "chat" });
    expect(third.deadLoop.detected).toBe(true);
  });

  it("resetGuardrailTrace clears the dead-loop window", () => {
    const traceKey = "reset-trace";
    const payload = "## Handoff\n\n- item\n\n```ts path=a.ts\nx\n```";
    for (let i = 0; i < 3; i++) {
      classifyHandoff({ sourceAgent: source, targetAgent: target, payload, traceKey, stage: "chat" });
    }
    resetGuardrailTrace(traceKey);
    const after = classifyHandoff({ sourceAgent: source, targetAgent: target, payload, traceKey, stage: "chat" });
    expect(after.deadLoop.detected).toBe(false);
    expect(after.deadLoop.occurrences).toBe(1);
  });
});