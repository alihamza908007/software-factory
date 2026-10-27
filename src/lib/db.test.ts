import { describe, it, expect } from "vitest";
import { getDb, updateDb, projectThreadMessages } from "@/lib/db";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("projectThreadMessages", () => {
  it("separates direct and handoff messages", () => {
    const messages = [
      { id: "1", role: "user", content: "hi", createdAt: 1 } as any,
      { id: "2", role: "assistant", content: "reply", handoffFrom: "dev", createdAt: 2 } as any,
      { id: "3", role: "assistant", content: "direct", createdAt: 3 } as any,
    ];
    const projection = projectThreadMessages(messages);
    expect(projection.directCount).toBe(2);
    expect(projection.handoffCount).toBe(1);
    expect(projection.totalCount).toBe(3);
    expect(projection.direct.map((m) => m.id)).toEqual(["1", "3"]);
    expect(projection.handoffs.map((m) => m.id)).toEqual(["2"]);
  });

  it("handles empty and all-handoff cases", () => {
    expect(projectThreadMessages([]).directCount).toBe(0);
    const allHandoff = [
      { id: "a", role: "assistant", content: "x", handoffFrom: "m", createdAt: 1 } as any,
    ];
    const p = projectThreadMessages(allHandoff);
    expect(p.directCount).toBe(0);
    expect(p.handoffCount).toBe(1);
  });
});

describe("db persistence", () => {
  it("persists mutations to disk and reloads", async () => {
    const db = await getDb();
    const marker = `persist-test-${Date.now()}`;
    await updateDb((d) => {
      (d.settings as any).testMarker = marker;
    });
    const dataRoot = process.env.FACTORY_DATA_ROOT!;
    const dbPath = path.join(dataRoot, "factory.json");
    const raw = readFileSync(dbPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.settings.testMarker).toBe(marker);

    // reload from disk by clearing the in-memory cache
    const globalStore = globalThis as any;
    delete globalStore.__factoryDb;
    delete globalStore.__factoryWriteChain;
    const reloaded = await getDb();
    expect((reloaded.settings as any).testMarker).toBe(marker);
  });
});