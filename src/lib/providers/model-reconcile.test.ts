import { describe, it, expect } from "vitest";
import { planModelReconciliation } from "@/lib/providers/model-reconcile";
import type { Agent, ModelInfo, ModelKind } from "@/lib/core/types";

function model(
  key: string,
  kind: ModelKind,
  heavy: boolean,
  online = true,
): ModelInfo {
  return {
    key,
    provider: kind === "local" ? "ollama" : "opencode",
    modelId: key.split("/").slice(1).join("/"),
    name: key,
    kind,
    capabilities: ["completion"],
    heavy,
    vramEstimateMB: heavy ? 20_000 : 0,
    costInputPerMTok: 0,
    costOutputPerMTok: 0,
    zeroCost: true,
    source: "static",
    online,
  };
}

function agent(id: string, role: string, modelKey: string, fallbackModelKey?: string): Agent {
  return {
    id,
    name: id,
    handle: id,
    role,
    description: role,
    systemPrompt: "prompt",
    modelKey,
    fallbackModelKey,
    temperature: 0.2,
    maxTokens: 4096,
    allowConcurrency: true,
    enabled: true,
    color: "#000000",
    icon: "Bot",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("model reconciliation", () => {
  it("keeps agents whose model is still in the catalogue", () => {
    const models = [model("ollama/qwen3:8b", "local", false)];
    const plan = planModelReconciliation([agent("a", "Developer", "ollama/qwen3:8b")], models);
    expect(plan.updates).toHaveLength(0);
    expect(plan.unresolved).toHaveLength(0);
  });

  it("prefers the agent fallback when the assigned model disappears", () => {
    const models = [model("opencode/fallback", "cloud", false)];
    const plan = planModelReconciliation(
      [agent("a", "Developer", "ollama/gone:70b", "opencode/fallback")],
      models,
    );
    expect(plan.updates).toEqual([
      expect.objectContaining({ modelKey: "opencode/fallback" }),
    ]);
  });

  it("moves build roles onto a local heavy model before cloud", () => {
    const models = [
      model("opencode/cloud", "cloud", false),
      model("ollama/heavy:32b", "local", true),
      model("ollama/light:8b", "local", false),
    ];
    const plan = planModelReconciliation(
      [agent("a", "Developer", "ollama/gone:70b"), agent("b", "QA Engineer", "ollama/gone:70b")],
      models,
    );
    const byId = Object.fromEntries(plan.updates.map((item) => [item.agent.id, item.modelKey]));
    expect(byId.a).toBe("ollama/heavy:32b");
    expect(byId.b).toBe("opencode/cloud");
  });

  it("reports agents it cannot place when the catalogue is empty", () => {
    const plan = planModelReconciliation([agent("a", "Developer", "ollama/gone")], []);
    expect(plan.updates).toHaveLength(0);
    expect(plan.unresolved.map((item) => item.id)).toEqual(["a"]);
  });
});
