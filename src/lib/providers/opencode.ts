import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderMessage, ProviderResult } from "./ollama";
import type { ModelInfo } from "../types";

function buildPrompt(messages: ProviderMessage[]): string {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const conversation = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const label = message.role === "assistant" ? "ASSISTANT" : "USER";
      return `${label}:\n${message.content}`;
    })
    .join("\n\n");
  return [
    system
      ? `SYSTEM INSTRUCTIONS (highest priority):\n${system}\n\nYou are being invoked as a text-generation worker inside an automated SDLC pipeline. Do not call tools, do not edit files, do not ask questions. Return only the requested content.`
      : "You are a text-generation worker inside an automated SDLC pipeline. Do not call tools. Return only the requested content.",
    "---",
    conversation,
  ].join("\n\n");
}

/**
 * The OpenCode free tier rejects direct HTTP generation from third parties
 * ("free tier can only be used from within OpenCode") but accepts `opencode run`.
 * We therefore run a plan-mode CLI worker (read-only, edit tool denied) in a
 * scratch directory and consume its JSON event stream.
 */
let sandboxPromise: Promise<string> | undefined;
function cloudSandbox(): Promise<string> {
  sandboxPromise ??= (async () => {
    const dir = path.join(os.tmpdir(), "software-factory-cloud-worker");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  })();
  return sandboxPromise;
}

interface CliEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  error?: { message?: string; type?: string };
  part?: {
    type?: string;
    text?: string;
    reason?: string;
    tokens?: { input?: number; output?: number };
    cost?: number;
    time?: { start?: number; end?: number };
  };
}

export async function generateOpenCode(request: {
  model: ModelInfo;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string, fullText: string) => void;
  directory?: string;
  title?: string;
}): Promise<ProviderResult> {
  const prompt = buildPrompt(request.messages);
  const cwd = await cloudSandbox();
  const started = performance.now();
  const args = [
    "run",
    "--agent",
    "plan",
    "--model",
    `opencode/${request.model.modelId}`,
    "--format",
    "json",
    ...(request.title ? ["--title", request.title.slice(0, 80)] : []),
    prompt,
  ];

  return new Promise<ProviderResult>((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let text = "";
    let firstTokenAt: number | undefined;
    let providerError = "";
    let sessionId = "";
    let usageInput = 0;
    let usageOutput = 0;
    let usageCost = 0;
    let settled = false;
    let timedOut = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const succeed = (result: ProviderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: CliEvent;
      try {
        event = JSON.parse(trimmed) as CliEvent;
      } catch {
        return;
      }
      if (event.sessionID && !sessionId) sessionId = event.sessionID;
      if (event.type === "error") {
        providerError =
          event.error?.message || providerError || "OpenCode worker reported an error.";
        return;
      }
      if (event.type === "step_finish" && event.part?.tokens) {
        usageInput += event.part.tokens.input ?? 0;
        usageOutput += event.part.tokens.output ?? 0;
        usageCost += event.part.cost ?? 0;
        return;
      }
      if (event.type !== "text") return;
      const part = event.part;
      if (part?.type !== "text" || typeof part.text !== "string" || !part.text) return;
      const next = part.text;
      if (firstTokenAt === undefined) firstTokenAt = performance.now();
      if (next.startsWith(text)) {
        const delta = next.slice(text.length);
        text = next;
        if (delta) request.onToken?.(delta, text);
      } else {
        const separator = text && !next.startsWith("\n") ? "\n" : "";
        const delta = separator + next;
        text += delta;
        request.onToken?.(delta, text);
      }
    };

    const consumeChunk = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        consumeLine(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
      }
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    };

    child.stdout?.on("data", consumeChunk);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_000);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, 5 * 60_000);

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      fail(new DOMException("Generation aborted", "AbortError"));
    };
    if (request.signal) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      fail(
        new Error(
          `Could not launch the OpenCode CLI. Ensure \`opencode\` is on PATH. ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      request.signal?.removeEventListener("abort", onAbort);
      if (stdout.trim()) consumeLine(stdout);
      const totalMs = performance.now() - started;

      if (timedOut) {
        fail(new Error("OpenCode cloud generation timed out after 5 minutes."));
        return;
      }
      if (providerError && !text.trim()) {
        fail(
          new Error(
            providerError.includes("free tier")
              ? "OpenCode free tier rejected the request. Make sure the OpenCode CLI is signed in (`opencode auth login`)."
              : `OpenCode error: ${providerError}`,
          ),
        );
        return;
      }
      if (!text.trim()) {
        const detail = providerError || stderr.trim().slice(-800) || `exit code ${code ?? "?"}`;
        fail(new Error(`OpenCode returned an empty response. ${detail}`));
        return;
      }

      const inputTokens = usageInput || Math.max(1, Math.round(prompt.length / 4));
      const outputTokens = usageOutput || Math.max(1, Math.round(text.length / 4));
      const ttftMs = firstTokenAt ? firstTokenAt - started : totalMs;
      // The JSON event stream delivers text in blocks, so wall-clock generation
      // time is the honest denominator for throughput.
      const tokensPerSec = outputTokens / Math.max(0.001, totalMs / 1000);
      const costUsd = request.model.zeroCost
        ? 0
        : usageCost ||
          (inputTokens / 1_000_000) * request.model.costInputPerMTok +
            (outputTokens / 1_000_000) * request.model.costOutputPerMTok;

      succeed({
        text,
        inputTokens,
        outputTokens,
        ttftMs,
        totalMs,
        tokensPerSec,
        vramMB: 0,
        costUsd,
        modelKey: request.model.key,
        provider: "opencode",
        rawFinish: "stop",
      });
    });
  });
}
