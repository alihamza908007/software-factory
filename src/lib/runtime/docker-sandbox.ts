import { spawn } from "node:child_process";
import path from "node:path";
import { getProject, WORKSPACES_ROOT } from "../db";
import type { CommandResult } from "../types";

/**
 * Enterprise-Grade Docker Sandbox Isolation.
 *
 * Runs builds, tests, and migrations inside an ephemeral Docker container
 * bound to the workspace volume, ensuring zero risk to the host filesystem.
 */

export interface DockerSandboxOptions {
  projectId: string;
  image?: string;
  command: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface DockerSandboxResult extends CommandResult {
  containerId?: string;
  image: string;
}

const DEFAULT_IMAGE = "node:20-alpine";

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["info"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function runInDockerSandbox(options: DockerSandboxOptions): Promise<DockerSandboxResult> {
  const project = await getProject(options.projectId);
  if (!project) throw new Error("Project not found.");
  const root = path.resolve(project.workspacePath);
  const workspaces = path.resolve(WORKSPACES_ROOT);
  if (root === workspaces || !root.startsWith(`${workspaces}${path.sep}`)) {
    throw new Error("Project path is outside the managed workspace root.");
  }

  const image = options.image ?? DEFAULT_IMAGE;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 180_000, 1_000), 600_000);
  const started = Date.now();
  const containerName = `factory-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const args = [
    "run",
    "--rm",
    "--name", containerName,
    "-v", `${root}:/workspace`,
    "-w", "/workspace",
    ...Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image,
    ...options.command,
  ];

  return new Promise<DockerSandboxResult>((resolve) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["kill", containerName], { stdio: "ignore" });
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      options.onOutput?.("stdout", text);
    });
    proc.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      options.onOutput?.("stderr", text);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: options.command.join(" "),
        cwd: root,
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: stdout.slice(-20_000),
        stderr: stderr.slice(-20_000),
        durationMs: Date.now() - started,
        timedOut,
        image,
        containerId: containerName,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command: options.command.join(" "),
        cwd: root,
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n${String(err)}`,
        durationMs: Date.now() - started,
        timedOut: false,
        image,
        containerId: containerName,
      });
    });
  });
}