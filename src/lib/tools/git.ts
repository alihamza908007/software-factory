import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitState } from "../types";
import { getSettings } from "../db";
import { runCommand } from "./terminal";

async function git(
  root: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const result = await runCommand("git", args, {
    cwd: root,
    timeoutMs: 60_000,
    env,
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.exitCode,
  };
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function initRepo(root: string, projectName: string): Promise<GitState> {
  const settings = await getSettings();
  if (!(await isGitRepo(root))) {
    await git(root, ["init", "-b", "main"]);
  }
  await git(root, ["config", "user.name", settings.gitAuthorName]);
  await git(root, ["config", "user.email", settings.gitAuthorEmail]);
  await git(root, ["config", "commit.gpgsign", "false"]);

  let state = await readGitState(root);
  if (!state.commits.length) {
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", `chore: scaffold ${projectName}`]);
    state = await readGitState(root);
  }
  return state;
}

export async function ensureRunBranch(
  root: string,
  branch: string,
): Promise<{ branch: string; baseBranch: string }> {
  const current = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseBranch = current.ok ? current.stdout.trim() : "main";
  const exists = await git(root, ["rev-parse", "--verify", branch]);
  if (exists.ok) {
    const suffix = Date.now().toString(36).slice(-4);
    branch = `${branch}-${suffix}`;
  }
  const checkout = await git(root, ["checkout", "-b", branch]);
  if (!checkout.ok) {
    throw new Error(`Could not create branch ${branch}: ${checkout.stderr.slice(-500)}`);
  }
  return { branch, baseBranch };
}

export async function commitAll(
  root: string,
  message: string,
): Promise<{ committed: boolean; hash?: string; message: string; error?: string }> {
  const status = await git(root, ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    return { committed: false, message, error: "No changes to commit." };
  }
  await git(root, ["add", "-A"]);
  const commit = await git(root, ["commit", "-m", message]);
  if (!commit.ok) {
    return { committed: false, message, error: commit.stderr.slice(-800) };
  }
  const hash = await git(root, ["rev-parse", "--short", "HEAD"]);
  return { committed: true, hash: hash.stdout.trim(), message };
}

export async function readGitState(root: string): Promise<GitState> {
  if (!(await isGitRepo(root))) {
    return { initialized: false, commits: [], dirtyFiles: 0, pushed: false };
  }
  const branchResult = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const logResult = await git(root, [
    "log",
    "-12",
    "--pretty=format:%h%x1f%s%x1f%ct",
  ]);
  const statusResult = await git(root, ["status", "--porcelain"]);
  const remoteResult = await git(root, ["remote", "get-url", "origin"]);
  const commits = logResult.ok
    ? logResult.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, message, timestamp] = line.split("\x1f");
          return {
            hash: hash ?? "",
            message: message ?? "",
            at: timestamp ? Number(timestamp) * 1000 : Date.now(),
          };
        })
    : [];
  return {
    initialized: true,
    branch: branchResult.stdout.trim() || undefined,
    commits,
    dirtyFiles: statusResult.stdout.split("\n").filter(Boolean).length,
    pushed: false,
    remote: remoteResult.ok ? remoteResult.stdout.trim() : undefined,
  };
}

export async function diffStat(root: string): Promise<string> {
  const result = await git(root, ["diff", "--stat", "HEAD"]);
  return result.stdout.trim();
}

async function withAskPass<T>(
  token: string,
  operation: () => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-git-"));
  const scriptPath = path.join(dir, "askpass.sh");
  const script = `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' "x-access-token" ;;\n  *) printf '%s\\n' "$GIT_TOKEN" ;;\nesac\n`;
  await fs.writeFile(scriptPath, script, { mode: 0o700 });
  try {
    const originalAskpass = process.env.GIT_ASKPASS;
    process.env.GIT_ASKPASS = scriptPath;
    process.env.GIT_TERMINAL_PROMPT = "0";
    process.env.GIT_TOKEN = token;
    try {
      return await operation();
    } finally {
      if (originalAskpass === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = originalAskpass;
      delete process.env.GIT_TERMINAL_PROMPT;
      delete process.env.GIT_TOKEN;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function pushBranch(
  root: string,
  branch: string,
  owner: string,
  repo: string,
  token: string,
): Promise<{ pushed: boolean; remote: string; error?: string }> {
  const remote = `https://github.com/${owner}/${repo}.git`;
  const existing = await git(root, ["remote", "get-url", "origin"]);
  if (existing.ok) {
    await git(root, ["remote", "set-url", "origin", remote]);
  } else {
    await git(root, ["remote", "add", "origin", remote]);
  }

  const result = await withAskPass(token, async () =>
    git(root, ["push", "-u", "origin", branch], {
      GIT_ASKPASS: process.env.GIT_ASKPASS ?? "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_TOKEN: token,
    }),
  );

  if (!result.ok) {
    return {
      pushed: false,
      remote,
      error: sanitizeGitError(result.stderr || result.stdout, token),
    };
  }
  return { pushed: true, remote };
}

function sanitizeGitError(text: string, token: string): string {
  let cleaned = text;
  if (token) cleaned = cleaned.split(token).join("***");
  return cleaned.trim().slice(-1200);
}

export function branchNameFor(slug: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `factory/${slug || "change"}-${date}-${suffix}`;
}
