import { promises as fs } from "node:fs";
import path from "node:path";
import type { CommandResult, Project } from "@/lib/core/types";
import { getSettings } from "@/lib/data/db";
import { listWorkspaceFiles } from "@/lib/data/workspace";
import { runCommand } from "@/lib/runtime/tools/terminal";

const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

/**
 * The user-facing `commandTimeoutMs` is a base budget. Tests and builds keep a
 * floor so lowering the setting for lint checks cannot truncate a real build.
 */
async function commandBudget(kind: "lint" | "test" | "build"): Promise<number> {
  const settings = await getSettings();
  const base = Math.max(MIN_TIMEOUT_MS, Math.min(settings.commandTimeoutMs, MAX_TIMEOUT_MS));
  if (kind === "build") return Math.max(base, 300_000);
  if (kind === "test") return Math.max(base, 180_000);
  return base;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function runInstallIfNeeded(
  root: string,
  stack: Project["stack"],
  timeoutMs: number,
): Promise<CommandResult[]> {
  if (stack === "python") return [];
  const pkg = await readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(path.join(root, "package.json"));
  if (!pkg) return [];
  const hasDeps = Object.keys(pkg.dependencies ?? {}).length > 0;
  if (!hasDeps) return [];
  try {
    await fs.access(path.join(root, "node_modules"));
    return [];
  } catch {
    return [
      await runCommand("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
        cwd: root,
        timeoutMs: Math.max(timeoutMs, 300_000),
      }),
    ];
  }
}

export async function runLint(root: string, stack: Project["stack"]): Promise<CommandResult[]> {
  const budget = await commandBudget("lint");
  const files = await listWorkspaceFiles(root, 400);
  const results: CommandResult[] = [];

  if (stack === "python") {
    const pyFiles = files.filter(
      (file) => file.endsWith(".py") && !file.startsWith(".") && !file.includes("/."),
    );
    for (const file of pyFiles.slice(0, 60)) {
      results.push(
        await runCommand("python3", ["-m", "py_compile", file], {
          cwd: root,
          timeoutMs: budget,
        }),
      );
    }
    return results;
  }

  const pkg = await readJson<{ scripts?: Record<string, string> }>(
    path.join(root, "package.json"),
  );
  if (pkg?.scripts?.check) {
    results.push(
      await runCommand("npm", ["run", "check"], { cwd: root, timeoutMs: budget }),
    );
    return results;
  }

  const jsFiles = files.filter(
    (file) =>
      /\.(js|mjs|cjs)$/.test(file) &&
      !file.includes("node_modules") &&
      !file.includes(".next") &&
      !file.startsWith("."),
  );
  for (const file of jsFiles.slice(0, 60)) {
    results.push(
      await runCommand("node", ["--check", file], { cwd: root, timeoutMs: budget }),
    );
  }
  return results;
}

export async function runTests(root: string, stack: Project["stack"]): Promise<CommandResult[]> {
  const budget = await commandBudget("test");
  if (stack === "python") {
    const files = await listWorkspaceFiles(root, 200);
    const usesPytest =
      files.some((file) => file.endsWith("pytest.ini") || file.endsWith("conftest.py")) ||
      (
        await fs.readFile(path.join(root, "requirements.txt"), "utf8").catch(() => "")
      ).includes("pytest");
    if (usesPytest) {
      const pytest = await runCommand("python3", ["-m", "pytest", "-q"], {
        cwd: root,
        timeoutMs: budget,
      });
      if (!/No module named pytest/i.test(pytest.stderr)) return [pytest];
    }
    return [
      await runCommand("python3", ["-m", "unittest", "discover", "-s", "tests", "-v"], {
        cwd: root,
        timeoutMs: budget,
      }),
    ];
  }

  const pkg = await readJson<{ scripts?: Record<string, string> }>(
    path.join(root, "package.json"),
  );
  if (pkg?.scripts?.test) {
    return [await runCommand("npm", ["test", "--silent"], { cwd: root, timeoutMs: budget })];
  }
  return [await runCommand("node", ["--test"], { cwd: root, timeoutMs: budget })];
}

export async function runBuild(root: string, stack: Project["stack"]): Promise<CommandResult[]> {
  const budget = await commandBudget("build");
  const pkg = await readJson<{ scripts?: Record<string, string> }>(
    path.join(root, "package.json"),
  );
  if (stack === "python") return [];
  if (pkg?.scripts?.build) {
    return [await runCommand("npm", ["run", "build"], { cwd: root, timeoutMs: budget })];
  }
  return [];
}

export function resultsFailed(results: CommandResult[]): boolean {
  return results.some((result) => result.exitCode !== 0 || result.timedOut);
}

export function formatCommandResults(results: CommandResult[]): string {
  return results
    .map((result) => {
      const status = result.exitCode === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
      return `$ ${result.command} [${status} · ${result.durationMs}ms]\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    })
    .join("\n\n");
}

export function failureDigest(results: CommandResult[], maxChars = 9000): string {
  const failed = results.filter((result) => result.exitCode !== 0 || result.timedOut);
  const text = formatCommandResults(failed);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars / 2)}\n\n… (truncated) …\n\n${text.slice(-maxChars / 2)}`;
}

export async function detectStack(root: string): Promise<Project["stack"]> {
  const files = await listWorkspaceFiles(root, 200);
  if (files.some((file) => /^(next\.config|app\/page)/.test(file))) return "next";
  if (files.some((file) => file.endsWith(".py"))) return "python";
  return "node";
}
