import { parseFileBlocks } from "../orchestrator/parse";
import { putScratchpadContent } from "../system/storage-cleaner";
import { readCachedWorkspaceFile, setCachedWorkspaceMetadata } from "./shared-cache";

export interface CompactAgentContext {
  summary: string;
  artifactPointers: string[];
  text: string;
}

/** Keep cross-agent handoffs small while preserving file locations and concrete decisions. */
export function compactAgentContext(input: string, maxChars = 2_400): CompactAgentContext {
  const artifacts = parseFileBlocks(input).map((file) => file.path);
  const withoutCode = input.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const sentences = withoutCode
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 24)
    .slice(0, 3);
  const summary = (sentences.join(" ") || "Agent completed work; inspect the referenced artifacts for details.").slice(0, 900);
  const pointerText = artifacts.length ? `Artifact pointers: ${artifacts.slice(0, 20).join(", ")}` : "Artifact pointers: none";
  const text = `${summary}\n${pointerText}`.slice(0, maxChars);
  return { summary, artifactPointers: artifacts.slice(0, 20), text };
}

export async function resolveHandoffContext(
  input: string,
  workspacePath: string | undefined,
  objective: string,
  taskContext: { agentId?: string; taskId?: string } = {},
): Promise<string> {
  const compact = compactAgentContext(input);
  if (!workspacePath || !compact.artifactPointers.length) return compact.text;
  const terms = objective.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? [];
  const paths = compact.artifactPointers
    .filter((file) => !/(^|\/)(\.env[^/]*|node_modules|\.git)(\/|$)/i.test(file))
    .map((file) => ({ file, score: terms.filter((term) => file.toLowerCase().includes(term)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const excerpts: string[] = [];
  for (const { file } of paths) {
    try {
      // The cache is the shared read-through layer: the first agent reads disk,
      // every peer reuses the same contents without another tool call.
      const content = await readCachedWorkspaceFile(workspacePath, file, {
        runId: taskContext.taskId,
        agentId: taskContext.agentId,
        ttlMs: 15 * 60 * 1000,
      });
      if (/\.json$/i.test(file)) {
        try {
          setCachedWorkspaceMetadata(workspacePath, "json", file, JSON.parse(content), {
            runId: taskContext.taskId,
            agentId: taskContext.agentId,
          });
        } catch {
          // Malformed JSON is reported by the post-flight audit, not here.
        }
      }
      if (taskContext.agentId && taskContext.taskId) {
        putScratchpadContent({
          agentId: taskContext.agentId,
          taskId: taskContext.taskId,
          key: file,
          content,
        });
      }
      excerpts.push(`${file}:\n${content.slice(0, 1_800)}${content.length > 1_800 ? "\n[…file excerpt shortened…]" : ""}`);
    } catch {
      // Newly generated artifacts may not exist in the workspace yet; keep the pointer.
    }
  }
  return excerpts.length ? `${compact.text}\n\nRelevant cached artifact excerpts:\n${excerpts.join("\n\n")}` : compact.text;
}

export function compactConversationHistory<T extends { role: "user" | "assistant"; content: string; agentName?: string }>(
  history: T[],
  maxMessages = 12,
): Array<T | (T & { content: string })> {
  const recent = history.slice(-maxMessages);
  return recent.map((message) => message.role === "assistant"
    ? { ...message, content: compactAgentContext(message.content, 1_500).text }
    : message);
}

export function tokenBudgetForTask(text: string): number {
  const complexity = text.length + (text.match(/\b(implement|build|refactor|multiple files|architecture|integrate)\b/gi)?.length ?? 0) * 1_000;
  return complexity > 3_500 ? 4_096 : 2_048;
}
