import { spawn } from "node:child_process";
import type { CommandResult } from "../types";

const ALLOWED_COMMANDS = new Set([
  "npm",
  "npx",
  "node",
  "python3",
  "python",
  "pytest",
  "git",
  "ls",
  "cat",
  "echo",
]);

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  allowlist?: boolean;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

const MAX_OUTPUT = 240_000;

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  if (options.allowlist !== false && !ALLOWED_COMMANDS.has(command)) {
    return {
      command: [command, ...args].join(" "),
      cwd: options.cwd,
      exitCode: 126,
      stdout: "",
      stderr: `Command "${command}" is not on the factory allowlist.`,
      durationMs: 0,
      timedOut: false,
    };
  }

  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: options.cwd,
        CI: "1",
        NODE_ENV: "test",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        ...options.env,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      options.onOutput?.("stdout", chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      options.onOutput?.("stderr", chunk.toString("utf8"));
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(" "),
        cwd: options.cwd,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGKILL");
      }
      setTimeout(() => {
        try {
          if (child.pid && process.platform !== "win32") {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // process already gone
        }
      }, 1500);
    }, timeoutMs);

    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}

export function tailOutput(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return `… (${text.length - maxChars} chars omitted)\n${text.slice(-maxChars)}`;
}
