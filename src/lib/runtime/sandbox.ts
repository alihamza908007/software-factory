import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { getProject, getSettings, WORKSPACES_ROOT } from "../db";
import type { CommandResult } from "../types";
import { runCommand } from "../tools/terminal";
import type { RuntimeProof } from "../mesh/accountability";

export interface RuntimeCommandEvent {
  stream: "stdout" | "stderr";
  text: string;
  command: string;
}

export interface RunTerminalCommandOptions {
  projectId: string;
  command: string;
  timeoutMs?: number;
  onOutput?: (event: RuntimeCommandEvent) => void;
}

function parseVerificationCommand(command: string): { binary: string; args: string[] } {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 240 || /[;&|`$<>\n\r]/.test(normalized)) {
    throw new Error("Runtime command rejected: shell operators, substitutions, and multiline input are not allowed.");
  }
  const approved: Record<string, { binary: string; args: string[] }> = {
    "npm run build": { binary: "npm", args: ["run", "build"] },
    "npm run test": { binary: "npm", args: ["run", "test"] },
    "npm test": { binary: "npm", args: ["test", "--silent"] },
    "npm run lint": { binary: "npm", args: ["run", "lint"] },
    "npm run typecheck": { binary: "npm", args: ["run", "typecheck"] },
    "npm run start": { binary: "npm", args: ["run", "start"] },
    "npx prisma validate": { binary: "npx", args: ["--no-install", "prisma", "validate"] },
    "node --test": { binary: "node", args: ["--test"] },
    "python3 -m unittest discover -s tests -v": { binary: "python3", args: ["-m", "unittest", "discover", "-s", "tests", "-v"] },
  };
  const parsed = approved[normalized];
  if (!parsed) throw new Error(`Runtime command rejected: "${normalized}" is not an approved verification command.`);
  return parsed;
}

async function verifiedProjectRoot(projectId: string): Promise<string> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Runtime command rejected: project does not exist.");
  const [root, workspaces] = await Promise.all([realpath(project.workspacePath), realpath(WORKSPACES_ROOT)]);
  if (root === workspaces || !root.startsWith(`${workspaces}${path.sep}`)) {
    throw new Error("Runtime command rejected: project path is outside the managed workspace root.");
  }
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error("Runtime command rejected: project workspace is not a directory.");
  return root;
}

export async function runTerminalCommand(options: RunTerminalCommandOptions): Promise<CommandResult> {
  const settings = await getSettings();
  if (!settings.allowExecution) throw new Error("Runtime command rejected: local execution is disabled in Settings.");
  const parsed = parseVerificationCommand(options.command);
  const cwd = await verifiedProjectRoot(options.projectId);
  return runCommand(parsed.binary, parsed.args, {
    cwd,
    timeoutMs: Math.min(Math.max(options.timeoutMs ?? 180_000, 1_000), 300_000),
    onOutput: (stream, text) => options.onOutput?.({ stream, text, command: options.command }),
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local verification port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

/** Starts only the project's declared start script, probes localhost, and always terminates its process group. */
export async function runServerHealthProbe(
  projectId: string,
  options: { onOutput?: (event: RuntimeCommandEvent) => void; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const settings = await getSettings();
  if (!settings.allowExecution) throw new Error("Runtime probe rejected: local execution is disabled in Settings.");
  const cwd = await verifiedProjectRoot(projectId);
  const port = await availablePort();
  const command = `npm run start -- --hostname 127.0.0.1 --port ${port}`;
  const startedAt = Date.now();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const child = spawn("npm", ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: cwd,
      CI: "1",
      NODE_ENV: "production",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const destination = stream === "stdout" ? stdoutChunks : stderrChunks;
    destination.push(text);
    while (destination.join("").length > 20_000) destination.shift();
    options.onOutput?.({ stream, text, command });
  };
  child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
  let exitCode: number | null = null;
  let spawnError = "";
  child.on("error", (error) => { spawnError = error.message; });
  child.on("close", (code) => { exitCode = code ?? 1; });

  const deadline = Date.now() + Math.min(Math.max(options.timeoutMs ?? 20_000, 3_000), 45_000);
  let responseStatus: number | undefined;
  try {
    while (Date.now() < deadline && exitCode === null && !spawnError) {
      let endpoint = `http://127.0.0.1:${port}/api/health`;
      let response: Response | undefined;
      try {
        response = await fetch(endpoint, { signal: AbortSignal.timeout(700) });
        if (response.status === 404) {
          await response.body?.cancel();
          endpoint = `http://127.0.0.1:${port}/`;
          response = await fetch(endpoint, { signal: AbortSignal.timeout(700) });
        }
        responseStatus = response.status;
        await response.body?.cancel();
        if (response.ok) {
          const summary = `HTTP ${response.status} ${endpoint}\n`;
          stdoutChunks.push(summary);
          return {
            command,
            cwd,
            exitCode: 0,
            stdout: stdoutChunks.join("").slice(-20_000),
            stderr: stderrChunks.join("").slice(-20_000),
            durationMs: Date.now() - startedAt,
            timedOut: false,
          };
        }
      } catch {
        // The local server is not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  } finally {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    } catch {
      // Process exited after SIGTERM.
    }
  }
  const stderr = `${stderrChunks.join("")}${spawnError ? `\n${spawnError}` : ""}${responseStatus ? `\nLocal endpoint returned HTTP ${responseStatus}.` : "\nServer did not return a successful localhost response before timeout."}`;
  return {
    command,
    cwd,
    exitCode: 1,
    stdout: stdoutChunks.join("").slice(-20_000),
    stderr: stderr.slice(-20_000),
    durationMs: Date.now() - startedAt,
    timedOut: Date.now() >= deadline,
  };
}

export function toRuntimeProof(result: CommandResult): RuntimeProof {
  return {
    commandExecuted: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-20_000),
    timestamp: new Date().toISOString(),
  };
}
