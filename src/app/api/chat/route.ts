import { getSettings, listAgents, getProject, getThread, createThread, appendThreadMessage, updateThreadMessage } from "@/lib/db";
import { generateWithAgent } from "@/lib/providers/router";
import { chatPrompt, handoffPrompt } from "@/lib/orchestrator/prompts";
import { parseMentions, readJson, sseChunk, sseHeaders } from "@/lib/api";
import { startRun } from "@/lib/orchestrator/engine";
import type { Agent, ChatMessage, ChatThread } from "@/lib/types";
import { readProjectFile, listWorkspaceFiles } from "@/lib/workspace";
import { slugify, uid } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

interface ChatBody {
  threadId?: string;
  projectId?: string;
  message: string;
  agentId?: string;
  mentions?: string[];
  autonomous?: boolean;
  autoHandoff?: boolean;
}

function findMentionedAgents(agents: Agent[], mentions: string[]): Agent[] {
  const result: Agent[] = [];
  for (const mention of mentions) {
    const match = agents.find(
      (agent) =>
        agent.enabled &&
        (agent.handle.toLowerCase() === mention ||
          slugify(agent.name) === mention ||
          slugify(agent.role) === mention ||
          agent.role.toLowerCase().split(/\s+/).includes(mention)),
    );
    if (match && !result.some((agent) => agent.id === match.id)) result.push(match);
  }
  return result;
}

async function projectContext(projectId?: string): Promise<string | undefined> {
  if (!projectId) return undefined;
  const project = await getProject(projectId);
  if (!project) return undefined;
  const spec = await readProjectFile(project.workspacePath, "docs/SPEC.md").catch(() => "");
  const files = await listWorkspaceFiles(project.workspacePath, 40).catch(() => []);
  return [
    `Name: ${project.name}`,
    `Stack: ${project.stack}`,
    `Brief: ${project.description}`,
    `Workspace: ${project.workspacePath}`,
    `Files: ${files.slice(0, 25).join(", ") || "scaffold"}`,
    spec ? `Specification excerpt:\n${spec.slice(0, 6000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function POST(request: Request) {
  let body: ChatBody;
  try {
    body = await readJson<ChatBody>(request);
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!body.message?.trim()) {
    return new Response(JSON.stringify({ error: "Message is required." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseChunk(event, data));
        } catch {
          closed = true;
        }
      };

      try {
        const settings = await getSettings();
        const agents = await listAgents();
        const now = Date.now();
        let thread: ChatThread | undefined;
        if (body.threadId) thread = await getThread(body.threadId);
        if (!thread) {
          thread = {
            id: body.threadId || uid("thr"),
            projectId: body.projectId,
            title: body.message.slice(0, 64),
            messages: [],
            createdAt: now,
            updatedAt: now,
          };
          await createThread(thread);
        }
        send("thread", { threadId: thread.id });

        const userMessage: ChatMessage = {
          id: uid("msg"),
          role: "user",
          content: body.message.trim(),
          mentions: parseMentions(body.message),
          createdAt: now,
        };
        await appendThreadMessage(thread.id, userMessage);
        send("message", userMessage);

        // Autonomous pipeline intent: launch the SDLC engine and return immediately.
        if (body.autonomous) {
          if (!body.projectId) {
            send("error", { message: "Select a project before launching an autonomous run." });
            send("done", {});
            controller.close();
            return;
          }
          const run = await startRun({
            projectId: body.projectId,
            prompt: body.message.trim(),
            pushToGitHub: false,
          });
          const notice: ChatMessage = {
            id: uid("msg"),
            role: "system",
            content: `Autonomous SDLC pipeline launched for **${run.projectName}**. Open the Pipeline view to watch the agents work.`,
            runId: run.id,
            createdAt: Date.now(),
          };
          await appendThreadMessage(thread.id, notice);
          send("run", { run });
          send("message", notice);
          send("done", { runId: run.id });
          controller.close();
          return;
        }

        const mentions =
          body.mentions?.map((mention) => mention.replace(/^@/, "").toLowerCase()) ??
          parseMentions(body.message);
        let targets = findMentionedAgents(agents, mentions);
        if (!targets.length) {
          const preferred =
            agents.find((agent) => agent.id === body.agentId) ??
            agents.find((agent) => agent.id === settings.defaultAgentId) ??
            agents.find((agent) => /product|manager/i.test(agent.role)) ??
            agents.find((agent) => agent.enabled);
          if (preferred) targets = [preferred];
        }
        if (!targets.length) throw new Error("No enabled agents are available.");

        const history = (await getThread(thread.id))?.messages ?? [];
        const context = await projectContext(body.projectId);
        const visited = new Set<string>();
        const queue: Array<{ agent: Agent; handoff?: { from: string; output: string } }> =
          targets.slice(0, 3).map((agent) => ({ agent }));
        const maxDepth = settings.maxHandoffDepth;
        let depth = 0;

        while (queue.length && depth <= maxDepth) {
          if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
          const item = queue.shift()!;
          if (visited.has(item.agent.id)) continue;
          visited.add(item.agent.id);
          depth += 1;

          const assistantMessage: ChatMessage = {
            id: uid("msg"),
            role: "assistant",
            content: "",
            agentId: item.agent.id,
            agentName: item.agent.name,
            agentColor: item.agent.color,
            handoffFrom: item.handoff?.from,
            pending: true,
            createdAt: Date.now(),
          };
          await appendThreadMessage(thread.id, assistantMessage);
          send("agent", {
            status: "start",
            agent: item.agent,
            messageId: assistantMessage.id,
            handoffFrom: item.handoff?.from,
          });

          const messages = item.handoff
            ? handoffPrompt(
                item.agent,
                item.handoff.from,
                body.message.trim(),
                item.handoff.output,
              )
            : chatPrompt(
                item.agent,
                history
                  .filter((message) => message.role === "user" || message.role === "assistant")
                  .map((message) => ({
                    role: message.role as "user" | "assistant",
                    content: message.content,
                    agentName: message.agentName,
                  })),
                body.message.trim(),
                context,
              );

          let accumulated = "";
          try {
            const outcome = await generateWithAgent({
              agent: item.agent,
              messages,
              purpose: `chat · ${item.agent.name}`,
              projectDir: body.projectId ? (await getProject(body.projectId))?.workspacePath : undefined,
              signal: request.signal,
              priority: 6,
              onToken: (delta, full) => {
                accumulated = full;
                send("token", {
                  messageId: assistantMessage.id,
                  agentId: item.agent.id,
                  delta,
                  text: full,
                });
              },
              onStatus: (status) => {
                send("agent", {
                  status: status.stage,
                  agent: item.agent,
                  messageId: assistantMessage.id,
                  detail: status.message,
                });
              },
            });
            const metrics = {
              modelKey: outcome.model.key,
              ttftMs: outcome.metric.ttftMs,
              totalMs: outcome.metric.totalMs,
              tokensPerSec: outcome.metric.tokensPerSec,
              inputTokens: outcome.metric.inputTokens,
              outputTokens: outcome.metric.outputTokens,
              costUsd: outcome.metric.costUsd,
              vramMB: outcome.metric.vramMB,
              fellBack: outcome.fellBack,
              queuedMs: outcome.metric.queuedMs,
            };
            await updateThreadMessage(thread.id, assistantMessage.id, {
              content: outcome.result.text,
              pending: false,
              metrics,
            });
            send("metrics", {
              messageId: assistantMessage.id,
              agentId: item.agent.id,
              metrics,
            });
            send("message", {
              ...assistantMessage,
              content: outcome.result.text,
              pending: false,
              metrics,
            });

            if (settings.autoHandoff) {
              const nextMention = parseMentions(outcome.result.text).find((mention) => {
                const next = findMentionedAgents(agents, [mention])[0];
                return next && !visited.has(next.id);
              });
              if (nextMention) {
                const nextAgent = findMentionedAgents(agents, [nextMention])[0];
                if (nextAgent) {
                  send("handoff", {
                    from: item.agent.name,
                    to: nextAgent.name,
                    handle: nextAgent.handle,
                    reason: `Mentioned in ${item.agent.name}'s output`,
                  });
                  queue.push({
                    agent: nextAgent,
                    handoff: { from: item.agent.name, output: outcome.result.text },
                  });
                }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await updateThreadMessage(thread.id, assistantMessage.id, {
              content: `Generation failed: ${message}`,
              pending: false,
              error: true,
            });
            send("error", { message, agentId: item.agent.id, messageId: assistantMessage.id });
          }
        }

        send("done", {});
        controller.close();
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : String(error) });
        send("done", {});
        try {
          controller.close();
        } catch {
          // closed
        }
      }
    },
    cancel() {
      // request.signal handles cancellation
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
