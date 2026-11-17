import { describe, it, expect } from "vitest";
import { executeDag, type DagNode } from "@/lib/pipeline/scheduler";

describe("executeDag resume", () => {
  it("reuses cached nodes and only re-runs the requested subset", async () => {
    const calls: string[] = [];
    let failB = true;
    const nodes: DagNode[] = [
      {
        id: "a",
        label: "A",
        dependsOn: [],
        run: async () => {
          calls.push("a");
          return { text: "A" };
        },
      },
      {
        id: "b",
        label: "B",
        dependsOn: [],
        run: async () => {
          calls.push("b");
          if (failB) throw new Error("boom");
          return { text: "B" };
        },
      },
      {
        id: "c",
        label: "C",
        dependsOn: ["a", "b"],
        run: async () => {
          calls.push("c");
          return { text: "C" };
        },
      },
    ];

    const first = await executeDag(nodes);
    expect(first.ok).toBe(false);
    expect(first.nodes.find((node) => node.id === "b")?.status).toBe("failed");
    expect(first.nodes.find((node) => node.id === "c")?.status).toBe("blocked");

    failB = false;
    calls.length = 0;
    const second = await executeDag(nodes, {
      resume: { outputs: first.outputs, rerun: new Set(["b", "c"]) },
    });

    expect(second.ok).toBe(true);
    expect(calls).toEqual(["b", "c"]);
    expect(second.nodes.find((node) => node.id === "a")?.status).toBe("passed");
  });
});
