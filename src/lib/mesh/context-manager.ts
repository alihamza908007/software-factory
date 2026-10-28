import { parseFileBlocks } from "../orchestrator/parse";
import { putScratchpadContent } from "../system/storage-cleaner";
import { readCachedWorkspaceFile, setCachedWorkspaceMetadata } from "./shared-cache";

export interface CompactAgentContext {
  summary: string;
  artifactPointers: string[];
  text: string;
}

/** Keep cross-agent handoffs small while preserving code structure, file locations and concrete decisions. */
export function compactAgentContext(input: string, maxChars = 2_400): CompactAgentContext {
  const trimmed = input.trim();
  const fileBlocks = parseFileBlocks(trimmed);
  const artifacts = fileBlocks.map((file) => file.path);

  // If already within budget, keep verbatim so code and instructions remain fully intact
  if (trimmed.length <= maxChars) {
    const withoutCode = trimmed.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
    const summary = withoutCode.replace(/\s+/g, " ").trim().slice(0, 500) || "Agent completed work.";
    return {
      summary,
      artifactPointers: artifacts.slice(0, 20),
      text: trimmed,
    };
  }

  // Preserve leading conversational explanation
  const withoutCode = trimmed.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const sentences = withoutCode
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 15)
    .slice(0, 4);
  const summary = (sentences.join(" ") || "Agent completed work; inspect the referenced artifacts for details.").slice(0, 800);

  // For code blocks, retain declarations / signatures instead of complete erasure
  const codeSignatures: string[] = [];
  for (const block of fileBlocks.slice(0, 5)) {
    const lines = block.content.split("\n");
    const sigLines = lines
      .filter((l) => /^(export|import|function|class|interface|type|const|def|class\s|async)\b/.test(l.trim()))
      .slice(0, 6);
    if (sigLines.length > 0) {
      codeSignatures.push(`\`${block.path}\` signatures:\n${sigLines.join("\n")}`);
    } else {
      codeSignatures.push(`\`${block.path}\` (${lines.length} lines)`);
    }
  }

  const pointerText = artifacts.length ? `Artifact pointers: ${artifacts.slice(0, 20).join(", ")}` : "Artifact pointers: none";
  const signatureSection = codeSignatures.length ? `\n\nCode structure:\n${codeSignatures.join("\n\n")}` : "";
  const text = `${summary}\n${pointerText}${signatureSection}`.slice(0, maxChars);

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
  maxMessages = 14,
): Array<T | (T & { content: string })> {
  const recent = history.slice(-maxMessages);
  const total = recent.length;
  return recent.map((message, index) => {
    if (message.role !== "assistant") return message;
    // Preserve the last 2 assistant messages in full detail (up to 4k chars) so follow-ups and code discussions have full context
    const isRecent = index >= total - 3;
    if (isRecent) {
      return {
        ...message,
        content: message.content.slice(0, 4_000),
      };
    }
    // Older assistant messages get smart context compaction with code signatures preserved
    return {
      ...message,
      content: compactAgentContext(message.content, 1_500).text,
    };
  });
}

export function tokenBudgetForTask(text: string): number {
  const complexity = text.length + (text.match(/\b(implement|build|refactor|multiple files|architecture|integrate)\b/gi)?.length ?? 0) * 1_000;
  return complexity > 3_500 ? 4_096 : 2_048;
}
