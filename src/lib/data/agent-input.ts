import type { Agent } from "@/lib/core/types";

const LIMITS = {
  name: 80,
  role: 120,
  handle: 40,
  description: 600,
  systemPrompt: 40_000,
  tags: 32,
  tagLength: 64,
};

function nonEmpty(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  if (trimmed.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}

function tagList(value: string[], label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (value.length > LIMITS.tags) throw new Error(`${label} can list at most ${LIMITS.tags} entries.`);
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} entries must be text.`);
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > LIMITS.tagLength) {
      throw new Error(`${label} entries must be 1–${LIMITS.tagLength} characters.`);
    }
    return trimmed;
  });
}

/**
 * Validate the editable agent fields shared by hire (POST) and update (PATCH).
 * Only fields present in the payload are checked, so a PATCH that flips
 * `enabled` does not have to resend the whole profile.
 */
export function assertAgentFields(body: Partial<Agent>): void {
  if (body.name !== undefined) nonEmpty(body.name, "Agent name", LIMITS.name);
  if (body.role !== undefined) nonEmpty(body.role, "Agent role", LIMITS.role);
  if (body.handle !== undefined) nonEmpty(body.handle, "Agent handle", LIMITS.handle);
  if (body.modelKey !== undefined) nonEmpty(body.modelKey, "Agent model", 200);
  if (body.systemPrompt !== undefined) {
    nonEmpty(body.systemPrompt, "Agent system prompt", LIMITS.systemPrompt);
  }
  if (body.description !== undefined && body.description.length > LIMITS.description) {
    throw new Error(`Agent description must be ${LIMITS.description} characters or fewer.`);
  }
  if (body.fallbackModelKey !== undefined && body.fallbackModelKey.length > 200) {
    throw new Error("Fallback model key is too long.");
  }
  if (
    body.temperature !== undefined &&
    (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)
  ) {
    throw new Error("Temperature must be between 0 and 2.");
  }
  if (
    body.maxTokens !== undefined &&
    (!Number.isInteger(body.maxTokens) || body.maxTokens < 256 || body.maxTokens > 32_768)
  ) {
    throw new Error("Max output tokens must be a whole number between 256 and 32,768.");
  }
  if (body.capabilities !== undefined) {
    body.capabilities = tagList(body.capabilities, "Capabilities");
  }
  if (body.skills !== undefined) {
    body.skills = tagList(body.skills, "Skills");
  }
}
