import { promises as fs } from "node:fs";
import path from "node:path";
import type { FactorySettings } from "./types";

const ENV_PATH = path.join(process.cwd(), ".env.local");

const ENV_MAP: Array<[keyof FactorySettings, string]> = [
  ["ollamaUrl", "OLLAMA_BASE_URL"],
  ["lmstudioUrl", "LMSTUDIO_BASE_URL"],
  ["opencodeUrl", "OPENCODE_URL"],
  ["openrouterApiKey", "OPENROUTER_API_KEY"],
  ["anthropicApiKey", "ANTHROPIC_API_KEY"],
  ["openaiApiKey", "OPENAI_API_KEY"],
  ["geminiApiKey", "GEMINI_API_KEY"],
];

const MANAGED_MARKER = "# --- software factory managed ---";

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "")}"`;
}

/**
 * Keep .env.local in sync with the provider settings so CLI tools, scripts and
 * a future server restart see the same credentials. Secrets never leave the
 * machine and the file is written with owner-only permissions.
 *
 * When `touched` is supplied only those fields are rewritten. This prevents a
 * settings save from blanking credentials that were placed in .env.local by
 * hand or by another integration.
 */
export async function syncEnvFile(
  settings: FactorySettings,
  touched?: Array<keyof FactorySettings>,
): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(ENV_PATH, "utf8");
  } catch {
    // first write
  }
  const selected = touched?.length
    ? ENV_MAP.filter(([key]) => touched.includes(key))
    : ENV_MAP;
  if (touched && !selected.length) return;
  const pending = new Map(
    selected.map(([key, env]) => [env, String(settings[key] ?? "").trim()]),
  );

  const lines = existing ? existing.split(/\r?\n/) : [];
  const next: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) {
      next.push(line);
      continue;
    }
    const env = match[1];
    if (!pending.has(env)) {
      next.push(line);
      continue;
    }
    const value = pending.get(env) ?? "";
    pending.delete(env);
    if (value) next.push(`${env}=${quote(value)}`);
    // An empty value removes the managed line instead of leaving KEY= behind.
  }

  for (const [env, value] of pending) {
    if (value) next.push(`${env}=${quote(value)}`);
  }

  const withoutMarker = next.filter((line) => line !== MANAGED_MARKER);
  while (withoutMarker.length && withoutMarker[withoutMarker.length - 1] === "") {
    withoutMarker.pop();
  }
  const body = [
    ...withoutMarker,
    "",
    MANAGED_MARKER,
    "# Updated by Settings → Providers. Empty values are intentionally removed.",
  ].join("\n");

  await fs.writeFile(ENV_PATH, `${body}\n`, { mode: 0o600 });
  await fs.chmod(ENV_PATH, 0o600).catch(() => undefined);
}
