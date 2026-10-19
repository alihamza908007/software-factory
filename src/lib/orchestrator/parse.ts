import { writeProjectFile } from "../workspace";

export interface ParsedFile {
  path: string;
  content: string;
  language?: string;
}

function normalizePath(input: string): string {
  return input
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\s+/g, "");
}

function parseInfo(info: string): { path?: string; language?: string } {
  const cleaned = info.trim();
  const pathMatch =
    cleaned.match(/(?:path|file|filename)\s*=\s*["']?([^\s"']+)["']?/i) ??
    cleaned.match(/(?:^|\s)([\w./-]+\.[a-zA-Z0-9]{1,8})(?:\s|$)/);
  let language: string | undefined;
  if (!pathMatch) {
    const first = cleaned.split(/\s+/)[0];
    if (first && !first.includes("=")) language = first;
  }
  return { path: pathMatch?.[1], language };
}

/**
 * Parses complete file payloads from an LLM response.
 * Primary contract: ```lang path=src/file.js ... ```
 * Also supports ```lang file=..., `*** Add File:` patches and `=== FILE: path ===`.
 */
export function parseFileBlocks(output: string): ParsedFile[] {
  const files = new Map<string, ParsedFile>();

  const fenceRegex = /```([^\n]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(output))) {
    const info = match[1] ?? "";
    const body = match[2] ?? "";
    const { path, language } = parseInfo(info);
    if (!path) continue;
    const normalized = normalizePath(path);
    if (!normalized || normalized.includes("..") || normalized.startsWith(".env")) continue;
    files.set(normalized, { path: normalized, content: body.replace(/\s+$/, "") + "\n", language });
  }

  const markerRegex = /===\s*FILE:\s*([^\n=]+)\s*===\n([\s\S]*?)(?=\n===\s*FILE:|$)/g;
  while ((match = markerRegex.exec(output))) {
    const normalized = normalizePath(match[1]);
    if (!normalized || normalized.includes("..") || files.has(normalized)) continue;
    files.set(normalized, {
      path: normalized,
      content: (match[2] ?? "").replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trimEnd() + "\n",
    });
  }

  const addFileRegex = /\*\*\* (?:Add|Update) File:\s*([^\n]+)\n([\s\S]*?)(?=\n\*\*\* (?:Add|Update|End) File|$)/g;
  while ((match = addFileRegex.exec(output))) {
    const normalized = normalizePath(match[1]);
    if (!normalized || normalized.includes("..") || files.has(normalized)) continue;
    const body = match[2]
      .split("\n")
      .filter((line) => line.startsWith("+") || line.startsWith(" "))
      .map((line) => line.slice(1))
      .join("\n");
    if (body.trim()) {
      files.set(normalized, { path: normalized, content: body.replace(/\s+$/, "") + "\n" });
    }
  }

  return Array.from(files.values());
}

export async function applyFileBlocks(
  root: string,
  files: ParsedFile[],
): Promise<{ written: string[]; errors: Array<{ path: string; error: string }> }> {
  const written: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const file of files) {
    try {
      const rel = await writeProjectFile(root, file.path, file.content);
      written.push(rel);
    } catch (error) {
      errors.push({ path: file.path, error: String(error) });
    }
  }
  return { written, errors };
}

export function summarizeFiles(files: ParsedFile[], max = 20): string {
  return files
    .slice(0, max)
    .map((file) => `- ${file.path} (${file.content.split("\n").length} lines)`)
    .join("\n");
}

export function extractCodeBlock(output: string, language?: string): string | undefined {
  const regex = language
    ? new RegExp("```" + language + "\\n([\\s\\S]*?)```", "i")
    : /```[^\n]*\n([\s\S]*?)```/;
  return regex.exec(output)?.[1]?.trim();
}
