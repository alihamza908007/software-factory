import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/**
 * Dynamic Skill & Tool Hot-Loading.
 *
 * A hot-loadable tool registry where agents can dynamically register and
 * invoke custom tools defined by JSON schemas, without recompiling the app.
 */

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  source: "builtin" | "hot-loaded" | "json-schema";
  registeredAt: number;
}

export interface ToolInvocationResult {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(tool: Omit<ToolDefinition, "registeredAt"> & { registeredAt?: number }): ToolDefinition {
  const full: ToolDefinition = { ...tool, registeredAt: tool.registeredAt ?? Date.now() };
  registry.set(full.name, full);
  return full;
}

export function unregisterTool(name: string): boolean {
  return registry.delete(name);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): ToolDefinition[] {
  return Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function invokeTool(name: string, args: Record<string, unknown> = {}): Promise<ToolInvocationResult> {
  const tool = registry.get(name);
  if (!tool) {
    return { tool: name, ok: false, error: `Tool "${name}" is not registered.`, durationMs: 0 };
  }
  const started = Date.now();
  try {
    const result = await tool.handler(args);
    return { tool: name, ok: true, result, durationMs: Date.now() - started };
  } catch (error) {
    return { tool: name, ok: false, error: String(error), durationMs: Date.now() - started };
  }
}

export function hotLoadFromJsonSchema(schema: {
  name: string;
  description: string;
  parameters?: ToolParameter[];
  handlerCode?: string;
}): ToolDefinition {
  // handlerCode is not eval'd for safety; callers must register a real handler.
  // This registers a schema-only tool whose handler echoes args (placeholder).
  return registerTool({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters ?? [],
    handler: async (args) => ({ echoed: args, note: "hot-loaded schema tool; attach a handler via registerTool" }),
    source: "json-schema",
  });
}

export function loadToolsFromDirectory(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const schema = JSON.parse(raw) as { name: string; description: string; parameters?: ToolParameter[] };
      if (schema.name) {
        hotLoadFromJsonSchema(schema);
        count++;
      }
    } catch {
      // skip malformed
    }
  }
  return count;
}

// Built-in example tools
registerTool({
  name: "json-validator",
  description: "Validate that a string is well-formed JSON.",
  parameters: [{ name: "text", type: "string", required: true }],
  handler: async (args) => {
    const text = String(args.text ?? "");
    try {
      const parsed = JSON.parse(text);
      return { valid: true, type: Array.isArray(parsed) ? "array" : typeof parsed };
    } catch (e) {
      return { valid: false, error: String(e) };
    }
  },
  source: "builtin",
});

registerTool({
  name: "tailwind-class-optimizer",
  description: "Deduplicate and sort Tailwind utility classes.",
  parameters: [{ name: "classes", type: "string", required: true }],
  handler: async (args) => {
    const classes = String(args.classes ?? "").split(/\s+/).filter(Boolean);
    const unique = Array.from(new Set(classes));
    return { original: classes.length, optimized: unique.length, classes: unique.join(" ") };
  },
  source: "builtin",
});