import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearVerificationCache,
  getCachedVerification,
  setCachedVerification,
  workspaceFingerprint,
} from "@/lib/data/verification-cache";

describe("verification cache", () => {
  it("changes the fingerprint when source files change", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "factory-fingerprint-"));
    writeFileSync(path.join(root, "index.js"), "export const ok = true;");
    const before = await workspaceFingerprint(root);
    writeFileSync(path.join(root, "index.js"), "export const ok = false;");
    const after = await workspaceFingerprint(root);
    expect(after).not.toBe(before);
  });

  it("returns a cached result only for the same fingerprint", () => {
    const runId = `test-${Date.now()}`;
    const results = [{
      command: "npm test",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      cwd: "/tmp/factory",
      durationMs: 1,
    }];
    setCachedVerification(runId, "abc", results, false);
    expect(getCachedVerification(runId, "abc")?.results).toEqual(results);
    expect(getCachedVerification(runId, "def")).toBeUndefined();
    clearVerificationCache(runId);
    expect(getCachedVerification(runId, "abc")).toBeUndefined();
  });
});
