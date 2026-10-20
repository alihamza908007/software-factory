import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apiError, json } from "@/lib/api";
import { getSettings } from "@/lib/db";
import { listModels, opencodeFetch } from "@/lib/providers/catalog";
import { resourceQueue } from "@/lib/queue/resource-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

async function availableMemoryMB(): Promise<number> {
  if (process.platform !== "darwin") return Math.round(os.freemem() / 1024 ** 2);
  try {
    const { stdout } = await execFileAsync("vm_stat", [], { timeout: 1500 });
    const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (label: string) =>
      Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
    const available = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
    return Math.round((available * pageSize) / 1024 ** 2);
  } catch {
    return Math.round(os.freemem() / 1024 ** 2);
  }
}

export async function GET() {
  try {
    const settings = await getSettings();
    const started = Date.now();
    const [ollama, lmstudio, opencode, catalogue, resources, freeMemoryMB] = await Promise.all([
      fetch(`${settings.ollamaUrl.replace(/\/$/, "")}/api/version`, {
        signal: AbortSignal.timeout(1500),
      })
        .then(async (res) => (res.ok ? ((await res.json()) as { version?: string }) : null))
        .catch(() => null),
      fetch(`${settings.lmstudioUrl.replace(/\/+$/, "")}/models`, {
        signal: AbortSignal.timeout(1500),
      })
        .then(async (res) => (res.ok ? ((await res.json()) as { data?: unknown[] }) : null))
        .catch(() => null),
      opencodeFetch("/api/info", {}, 1500)
        .then(async (res) => (res.ok ? ((await res.json()) as { version?: string }) : null))
        .catch(() => null),
      listModels(),
      resourceQueue.snapshot(),
      availableMemoryMB(),
    ]);
    return json({
      ok: Boolean(ollama || lmstudio || opencode),
      latencyMs: Date.now() - started,
      ollama: { online: Boolean(ollama), version: ollama?.version, url: settings.ollamaUrl },
      lmstudio: {
        online: Boolean(lmstudio),
        models: lmstudio?.data?.length ?? 0,
        url: settings.lmstudioUrl,
      },
      opencode: {
        online: Boolean(opencode),
        version: opencode?.version,
        url: catalogue.opencodeUrl,
      },
      models: {
        total: catalogue.models.length,
        local: catalogue.models.filter((model) => model.kind === "local").length,
        cloud: catalogue.models.filter((model) => model.kind === "cloud").length,
        cloudOnline: catalogue.opencodeOnline,
      },
      hardware: {
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "Apple Silicon",
        cores: os.cpus().length,
        totalMemoryMB: Math.round(os.totalmem() / 1024 ** 2),
        freeMemoryMB,
        unifiedMemory: process.arch === "arm64" && process.platform === "darwin",
      },
      process: {
        uptimeSec: Math.round(process.uptime()),
        rssMB: Math.round(process.memoryUsage().rss / 1024 ** 2),
      },
      resources,
    });
  } catch (error) {
    return apiError(error);
  }
}
