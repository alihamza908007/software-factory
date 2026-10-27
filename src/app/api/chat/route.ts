import {
  appendThreadMessage,
  createThread,
  getActiveTopology,
  getAgent,
  getProject,
  getSettings,
  getThread,
  listAgents,
  updateThreadMessage,
} from "@/lib/db";
import { generateWithAgent } from "@/lib/providers/router";
import { chatPrompt, handoffPrompt } from "@/lib/orchestrator/prompts";
import { correctiveInstruction, resetGuardrailTrace, validateAgentHandoff } from "@/lib/orchestrator/guardrails";
import { parseMentions, readJson, sseChunk, sseHeaders } from "@/lib/api";
import { startRun } from "@/lib/orchestrator/engine";
import { applyFileBlocks, parseFileBlocks } from "@/lib/orchestrator/parse";
import type { Agent, ChatMessage, ChatThread } from "@/lib/types";
import { readProjectFile, listWorkspaceFiles } from "@/lib/workspace";
import { uid } from "@/lib/utils";
import { isAgentPaused } from "@/lib/mesh/controls";
import {
  hydrateMeshEvents,
  inferResolutionPath,
  meshBus,
  publishAgentEnvelope,
  publishScopeAdvisories,
  setMeshAgentStatus,
} from "@/lib/mesh/event-bus";
import { learnFromFailure } from "@/lib/mesh/agent-memory";
import { ensureValidatorRuntime, validateArtifactsOnce, verifyPostFlight } from "@/lib/mesh/validators";
import { acceptTask, createTaskContract, routeTask, scopeHandoffCapabilities } from "@/lib/mesh/accountability";
import { negotiateTaskOwnership } from "@/lib/mesh/negotiation";
import { compactAgentContext, compactConversationHistory, resolveHandoffContext, tokenBudgetForTask } from "@/lib/mesh/context-manager";
import { resolveAgentHandles } from "@/lib/mesh/router";
import { validateCanvasTopology } from "@/lib/canvas/topology";

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
    `Absolute workspace root: ${project.workspacePath}`,
    `Authoritative file tree:\n${files.slice(0, 40).map((file) => `${project.workspacePath}/${file}`).join("\n") || "(scaffold)"}`,
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
        ensureValidatorRuntime();
        await hydrateMeshEvents();
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
        // The thread owns the project context when a follow-up message omits it.
        body.projectId = body.projectId ?? thread.projectId;
        send("thread", { threadId: thread.id, projectId: body.projectId });

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
          const activeTopology = await getActiveTopology();
          if (activeTopology) {
            const topologyValidation = validateCanvasTopology(activeTopology, agents);
            if (!topologyValidation.ok) {
              send("error", {
                message: `The active DAG is invalid: ${topologyValidation.errors.join(" ")} Fix it in the Pipeline canvas and retry.`,
              });
              send("done", {});
              controller.close();
              return;
            }
          }
          const run = await startRun({
            projectId: body.projectId,
            prompt: body.message.trim(),
            pushToGitHub: false,
            pipelineTopology: activeTopology ?? undefined,
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
        const mentionResolution = resolveAgentHandles(agents, mentions, body.message.trim());
        let targets = mentionResolution.agents;
        if (!targets.length) {
          const preferred =
            agents.find((agent) => agent.id === body.agentId) ??
            agents.find((agent) => agent.id === settings.defaultAgentId) ??
            agents.find((agent) => /product|manager/i.test(agent.role)) ??
            agents.find((agent) => agent.enabled);
          if (preferred) targets = [preferred];
        }
        if (!targets.length) throw new Error("No enabled agents are available.");
        // A valid @handle is an explicit assignment. Capability routing is for
        // unaddressed requests and unknown handles, never a reason to override
        // a user's valid named recipient.
        if (!mentions.length) {
          targets = Array.from(new Map(targets.map((agent) => {
            const routed = routeTask(agents, body.message.trim(), agent);
            if (routed.redirected && routed.agent) send("routing", { from: agent.name, to: routed.agent.name, reason: routed.reason });
            const selected = routed.agent ?? agent;
            return [selected.id, selected] as const;
          })).values());
        }
        if (mentions.length) {
          send("routing", {
            from: "You",
            to: targets.map((agent) => agent.name).join(", "),
            reason: mentionResolution.unknown.length
              ? "Resolved valid handles and redirected unknown handles through capability routing."
              : "Explicit @handle assignment honored.",
          });
        }

        const history = (await getThread(thread.id))?.messages ?? [];
        const context = await projectContext(body.projectId);
        const workspaceProject = body.projectId ? await getProject(body.projectId) : undefined;
        let workspaceSnapshot = workspaceProject
          ? { workspaceRoot: workspaceProject.workspacePath, fileTree: await listWorkspaceFiles(workspaceProject.workspacePath, 120) }
          : undefined;
        const supervisor = agents.find((agent) => agent.enabled && /product|manager|supervisor/i.test(`${agent.name} ${agent.role}`));
        const objectiveOverrides = new Map<string, string>();
        const capabilityOverrides = new Map<string, string[]>();
        // Multi-domain work is negotiated before any tokens are spent. Explicit
        // @handle assignment remains an intentional user override.
        if (!mentions.length) {
          const negotiation = await negotiateTaskOwnership({
            objective: body.message.trim(),
            agents,
            projectId: body.projectId,
            threadId: thread.id,
            managerId: supervisor?.id,
          });
          if (negotiation.negotiated && negotiation.assignments.length) {
            const negotiatedTargets = negotiation.assignments
              .map((assignment) => agents.find((agent) => agent.id === assignment.agentId && agent.enabled))
              .filter((agent): agent is Agent => Boolean(agent));
            if (negotiatedTargets.length) {
              targets = negotiatedTargets;
              for (const assignment of negotiation.assignments) {
                objectiveOverrides.set(assignment.agentId, assignment.objective);
                capabilityOverrides.set(assignment.agentId, assignment.lanes);
              }
              send("routing", {
                from: "Task negotiation",
                to: negotiation.assignments.map((assignment) => `${assignment.agentName} (${assignment.lanes.join(" + ")})`).join(", "),
                reason: negotiation.agreement,
                negotiationId: negotiation.id,
              });
            }
          }
        }
        resetGuardrailTrace(thread.id);
        const visited = new Map<string, number>();
        const visitCap = (agentId: string) => (agentId === supervisor?.id ? 2 : 1);
        const scheduled = new Set(targets.map((agent) => agent.id));
        const notifiedSupervisor = new Set<string>();
        const queue: Array<{
          agent: Agent;
          depth: number;
          objective?: string;
          requiredCapabilities?: string[];
          handoff?: { from: string; output: string; correction?: string; score?: number };
          contract?: ReturnType<typeof createTaskContract>;
        }> = targets.map((agent) => ({
          agent,
          depth: 0,
          objective: objectiveOverrides.get(agent.id),
          requiredCapabilities: capabilityOverrides.get(agent.id),
        }));
        const maxDepth = settings.maxHandoffDepth;
        const autoHandoff = body.autoHandoff ?? settings.autoHandoff;
        let frozen = false;

        while (queue.length && !frozen) {
          if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
          // Independent agents at the same handoff depth run concurrently;
          // downstream work joins the next wave after all current outputs land.
          const wave = queue.splice(0).filter(
            (item) => item.depth <= maxDepth && (visited.get(item.agent.id) ?? 0) < visitCap(item.agent.id),
          );
          for (const item of wave) visited.set(item.agent.id, (visited.get(item.agent.id) ?? 0) + 1);

          await Promise.all(
            wave.map(async (item) => {
              try {

                // Hot-swap: pick up prompt/model edits made while the thread was
                // already running. The queue keeps only an id, not a stale snapshot.
                const liveAgent = await getAgent(item.agent.id);
                if (liveAgent) item.agent = liveAgent;
                if (!item.agent.enabled) {
                  setMeshAgentStatus(item.agent.id, "paused", "Agent disabled in Agent Manager");
                  const notice: ChatMessage = { id: uid("msg"), role: "system", content: `**${item.agent.name} (@${item.agent.handle}) did not receive the task because this agent is disabled. Enable it in Agent Manager and retry.`, createdAt: Date.now(), error: true };
                  await appendThreadMessage(thread.id, notice);
                  send("message", notice);
                  return;
                }
                if (await isAgentPaused(item.agent.id)) {
                  meshBus.publish({
                    type: "AGENT_STATUS",
                    source: "Mesh Control",
                    agentId: item.agent.id,
                    threadId: thread.id,
                    projectId: body.projectId,
                    severity: "warning",
                    title: `${item.agent.name} is paused`,
                    message: "Handoff held by the operator. Resume the thread to continue.",
                    payload: { status: "paused", detail: "Thread paused by operator" },
                  });
                  const notice: ChatMessage = { id: uid("msg"), role: "system", content: `**${item.agent.name} (@${item.agent.handle}) is paused**, so the task was not run. Resume this agent in the Matrix or Mesh Hub and retry.`, createdAt: Date.now(), error: true };
                  await appendThreadMessage(thread.id, notice);
                  send("message", notice);
                  return;
                }

                const managerTask = item.handoff && /product|manager|supervisor/i.test(item.handoff.from)
                  ? item.handoff.output.match(/^NEXT_TASK:\s*(.+)$/im)?.[1]?.trim()
                  : undefined;
                const objective = item.objective ?? (item.handoff
                  ? `${managerTask ? `Manager follow-up: ${managerTask}` : body.message.trim()}\n${compactAgentContext(item.handoff.output, 1_000).text}`
                  : body.message.trim());
                const preFlightContext = {
                  workspaceRoot: workspaceSnapshot?.workspaceRoot,
                  fileTree: workspaceSnapshot?.fileTree ?? [],
                  projectId: body.projectId,
                  threadId: thread.id,
                };
                let contract = item.contract ?? createTaskContract({
                  sourceAgent: item.handoff?.from ?? "user",
                  targetAgent: item.agent.name,
                  objective,
                  requiredArtifacts: item.handoff ? compactAgentContext(item.handoff.output).artifactPointers : [],
                  requiredInputs: item.handoff ? compactAgentContext(item.handoff.output).artifactPointers : [],
                  requiredCapabilities: item.requiredCapabilities,
                  maxTokenBudget: tokenBudgetForTask(objective),
                });
                contract = acceptTask(contract, item.agent, preFlightContext);
                if (contract.status !== "ACCEPTED") {
                  meshBus.publish({
                    type: "TASK_CONTRACT",
                    source: contract.sourceAgent,
                    target: contract.targetAgent,
                    targetAgentId: item.agent.id,
                    threadId: thread.id,
                    projectId: body.projectId,
                    severity: contract.status === "BLOCKED" ? "error" : "warning",
                    title: contract.status === "BLOCKED" ? "Task blocked by pre-flight readiness" : "Task rejected by capability router",
                    message: contract.reason ?? "Capability mismatch.",
                    payload: { contract, preflight: contract.preflight, resolutionPath: contract.preflight?.resolutionPath },
                  });
                  if (contract.status === "BLOCKED") {
                    throw new Error(`${item.agent.name} pre-flight blocked: ${contract.reason ?? "required dependency missing"}${contract.preflight?.resolutionPath ? `\nResolution path: ${contract.preflight.resolutionPath}` : ""}`);
                  }
                  const reroute = routeTask(agents, objective, item.agent);
                  if (!reroute.agent || reroute.agent.id === item.agent.id) throw new Error(`Task rejected by ${item.agent.name}: ${contract.reason ?? "no qualified agent found"}`);
                  send("routing", { from: item.agent.name, to: reroute.agent.name, reason: contract.reason });
                  item.agent = reroute.agent;
                  contract = acceptTask({ ...contract, targetAgent: item.agent.name, status: "PENDING_ACCEPTANCE", reason: undefined }, item.agent, preFlightContext);
                  if (contract.status !== "ACCEPTED") {
                    throw new Error(`${item.agent.name} failed the rerouted pre-flight: ${contract.reason ?? "readiness check failed"}${contract.preflight?.resolutionPath ? `\nResolution path: ${contract.preflight.resolutionPath}` : ""}`);
                  }
                }
                meshBus.publish({
                  type: "TASK_CONTRACT",
                  source: contract.sourceAgent,
                  target: contract.targetAgent,
                  agentId: item.handoff ? undefined : item.agent.id,
                  targetAgentId: item.agent.id,
                  threadId: thread.id,
                  projectId: body.projectId,
                  severity: "success",
                  title: "Task accepted",
                  message: contract.reason ?? contract.objective.slice(0, 220),
                  payload: { contract },
                });
                if (!item.handoff) {
                  publishAgentEnvelope({
                    from: "user",
                    to: `@${item.agent.handle.replace(/^@/, "")}`,
                    type: "TASK_ASSIGNMENT",
                    payload: contract.objective,
                    timestamp: new Date().toISOString(),
                    resolutionPath: "Complete the assigned objective. If blocked, identify the exact file or dependency and provide the concrete fix or approved command.",
                    fileTree: workspaceSnapshot?.fileTree ?? [],
                    workspaceRoot: workspaceSnapshot?.workspaceRoot,
                    status: "INFO",
                  }, { targetAgentId: item.agent.id, threadId: thread.id, projectId: body.projectId });
                }

                setMeshAgentStatus(item.agent.id, "thinking", "Reading the request and prior handoff");
                meshBus.publish({
                  type: "AGENT_STATUS",
                  source: item.agent.name,
                  agentId: item.agent.id,
                  threadId: thread.id,
                  projectId: body.projectId,
                  severity: "info",
                  title: `${item.agent.name} is thinking`,
                  message: item.handoff
                    ? `Received handoff from ${item.handoff.from}.`
                    : "Triaging the user request.",
                  payload: { status: "thinking", detail: "Thinking" },
                });

                const assistantMessage: ChatMessage = {
                  id: uid("msg"),
                  role: "assistant",
                  content: "",
                  agentId: item.agent.id,
                  agentName: item.agent.name,
                  agentColor: item.agent.color,
                  handoffFrom: item.handoff?.from,
                  handoffScore: item.handoff?.score,
                  pending: true,
                  createdAt: Date.now(),
                };
                await appendThreadMessage(thread.id, assistantMessage);
                send("agent", {
                  status: "start",
                  agent: item.agent,
                  messageId: assistantMessage.id,
                  handoffFrom: item.handoff?.from,
                  handoffScore: item.handoff?.score,
                });

                const handoffContext = item.handoff
                  ? await resolveHandoffContext(item.handoff.output, workspaceProject?.workspacePath, objective, {
                      agentId: item.agent.id,
                      taskId: contract.taskId,
                    })
                  : undefined;
                const messages = item.handoff
                  ? handoffPrompt(
                      item.agent,
                      item.handoff.from,
                      body.message.trim(),
                      /product|manager|supervisor/i.test(`${item.agent.name} ${item.agent.role}`)
                        ? item.handoff.output
                        : handoffContext ?? item.handoff.output,
                      item.handoff.correction,
                      contract,
                      workspaceSnapshot,
                      agents,
                    )
                  : chatPrompt(
                      item.agent,
                      compactConversationHistory(history
                        .filter((message) => message.role === "user" || message.role === "assistant")
                        .map((message) => ({
                          role: message.role as "user" | "assistant",
                          content: message.content,
                          agentName: message.agentName,
                        })),
                      ),
                      body.message.trim(),
                      context,
                      contract,
                    );

                let executionMessages = messages;
                let accumulated = "";
                let lastSnapshotAt = 0;
                try {
                  setMeshAgentStatus(item.agent.id, "executing", "Generating a response");
                  let outcome = await generateWithAgent({
                    agent: item.agent,
                    messages,
                    purpose: `chat · ${item.agent.name}`,
                    projectDir: workspaceProject?.workspacePath,
                    signal: request.signal,
                    priority: 6,
                    maxTokens: contract.maxTokenBudget,
                    onToken: (delta, full) => {
                      accumulated = full;
                      const now = Date.now();
                      const cleaned = full.replace(/^TASK_ACCEPTED\s*:?\s*/i, "");
                      const sendFull = now - lastSnapshotAt > 150;
                      if (sendFull) lastSnapshotAt = now;
                      send("token", {
                        messageId: assistantMessage.id,
                        agentId: item.agent.id,
                        delta,
                        ...(sendFull ? { text: cleaned } : {}),
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
                  if (/^TASK_REJECTED\s*:/i.test(outcome.result.text.trim())) {
                    const rejectReason = outcome.result.text.trim().replace(/^TASK_REJECTED\s*:\s*/i, "").slice(0, 500);
                    contract = { ...contract, status: "REJECTED", reason: rejectReason };
                    meshBus.publish({
                      type: "TASK_CONTRACT",
                      source: contract.sourceAgent,
                      target: contract.targetAgent,
                      agentId: item.agent.id,
                      targetAgentId: item.agent.id,
                      threadId: thread.id,
                      projectId: body.projectId,
                      severity: "warning",
                      title: "Task rejected",
                      message: rejectReason,
                      payload: { contract },
                    });
                    const alternate = routeTask(agents.filter((agent) => agent.id !== item.agent.id), objective);
                    if (!alternate.agent) throw new Error(`${item.agent.name} rejected the task and no qualified alternate was found: ${rejectReason}`);
                    item.agent = alternate.agent;
                    contract = acceptTask({ ...contract, taskId: uid("task"), targetAgent: item.agent.name, status: "PENDING_ACCEPTANCE", reason: undefined }, item.agent);
                    send("routing", { from: assistantMessage.agentName, to: item.agent.name, reason: rejectReason });
                    meshBus.publish({
                      type: "TASK_CONTRACT",
                      source: contract.sourceAgent,
                      target: contract.targetAgent,
                      agentId: item.agent.id,
                      targetAgentId: item.agent.id,
                      threadId: thread.id,
                      projectId: body.projectId,
                      severity: "success",
                      title: "Rerouted task accepted",
                      message: contract.reason ?? contract.objective.slice(0, 220),
                      payload: { contract },
                    });
                    const retryMessages = item.handoff
                      ? handoffPrompt(
                          item.agent,
                          item.handoff.from,
                          body.message.trim(),
                          /product|manager|supervisor/i.test(`${item.agent.name} ${item.agent.role}`)
                            ? item.handoff.output
                            : handoffContext ?? item.handoff.output,
                          item.handoff.correction,
                          contract,
                          workspaceSnapshot,
                          agents,
                        )
                      : chatPrompt(item.agent, compactConversationHistory(history.filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ role: message.role as "user" | "assistant", content: message.content, agentName: message.agentName }))), body.message.trim(), context, contract);
                    executionMessages = retryMessages;
                    await updateThreadMessage(thread.id, assistantMessage.id, { agentId: item.agent.id, agentName: item.agent.name, agentColor: item.agent.color, content: "", pending: true });
                    assistantMessage.agentId = item.agent.id;
                    assistantMessage.agentName = item.agent.name;
                    assistantMessage.agentColor = item.agent.color;
                    outcome = await generateWithAgent({
                      agent: item.agent,
                      messages: retryMessages,
                      purpose: `chat · ${item.agent.name} · rerouted task`,
                      projectDir: workspaceProject?.workspacePath,
                      signal: request.signal,
                      priority: 6,
                      maxTokens: contract.maxTokenBudget,
                      onToken: (_delta, full) => send("token", { messageId: assistantMessage.id, agentId: item.agent.id, delta: full, text: full.replace(/^TASK_ACCEPTED\s*:?\s*/i, "") }),
                    });
                  }
                  const visibleAnswer = outcome.result.text.replace(/^TASK_ACCEPTED\s*:?\s*/i, "").trim();
                  if (!visibleAnswer || /^(?:task\s+)?accepted[.!\s]*$/i.test(visibleAnswer)) {
                    meshBus.publish({
                      type: "TASK_CONTRACT",
                      source: contract.sourceAgent,
                      target: contract.targetAgent,
                      agentId: item.agent.id,
                      targetAgentId: item.agent.id,
                      threadId: thread.id,
                      projectId: body.projectId,
                      severity: "warning",
                      title: "Acceptance received without an answer",
                      message: "The agent acknowledged the task but did not execute it. Requesting the actual response now.",
                      payload: { contract },
                    });
                    outcome = await generateWithAgent({
                      agent: item.agent,
                      messages: [
                        ...executionMessages,
                        { role: "user", content: "You acknowledged acceptance but did not answer. Continue now: complete the objective in this response. Do not repeat the acceptance marker or describe what you will do; provide the actual requested result." },
                      ],
                      purpose: `chat · ${item.agent.name} · answer recovery`,
                      projectDir: workspaceProject?.workspacePath,
                      signal: request.signal,
                      priority: 6,
                      maxTokens: contract.maxTokenBudget,
                      onToken: (_delta, full) => send("token", { messageId: assistantMessage.id, delta: full, text: full.replace(/^TASK_ACCEPTED\s*:?\s*/i, "") }),
                    });
                  }
                  const finalAnswer = outcome.result.text.replace(/^TASK_ACCEPTED\s*:?\s*/i, "").trim();
                  if (!finalAnswer || /^(?:task\s+)?accepted[.!\s]*$/i.test(finalAnswer)) {
                    throw new Error(`${item.agent.name} accepted the task but returned no answer after recovery. Please retry or choose another agent.`);
                  }
                  meshBus.publish({
                    type: "TASK_CONTRACT",
                    source: contract.sourceAgent,
                    target: contract.targetAgent,
                    agentId: item.agent.id,
                    targetAgentId: item.agent.id,
                    threadId: thread.id,
                    projectId: body.projectId,
                    severity: "success",
                    title: "Agent response delivered",
                    message: finalAnswer.slice(0, 1_000),
                    payload: { contract, response: finalAnswer },
                  });
                  const responseText = outcome.result.text.replace(/^TASK_ACCEPTED\s*:?\s*/i, "");
                  publishScopeAdvisories(item.agent.name, responseText, {
                    agentId: item.agent.id,
                    threadId: thread.id,
                    projectId: body.projectId,
                  });
                  const mentionedAgents = resolveAgentHandles(agents, parseMentions(responseText), `${body.message.trim()}\n${responseText}`).agents;
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

                  // Chat replies are executable work products: write fenced file
                  // blocks into the selected workspace before the next handoff.
                  const artifacts = parseFileBlocks(responseText);
                  let writtenArtifacts: string[] = [];
                  let artifactErrors: Array<{ path: string; error: string }> = [];
                  if (artifacts.length && workspaceProject) {
                    const applied = await applyFileBlocks(workspaceProject.workspacePath, artifacts);
                    writtenArtifacts = applied.written;
                    artifactErrors = applied.errors;
                    if (writtenArtifacts.length) {
                      workspaceSnapshot = {
                        workspaceRoot: workspaceProject.workspacePath,
                        fileTree: await listWorkspaceFiles(workspaceProject.workspacePath, 120),
                      };
                    }
                  }
                  const artifactPaths = writtenArtifacts.length
                    ? writtenArtifacts
                    : artifacts.map((file) => file.path);
                  const postFlight = await verifyPostFlight({
                    contract: {
                      ...contract,
                      requiredArtifacts: workspaceProject
                        ? artifactErrors.length
                          ? artifacts.map((file) => file.path)
                          : artifactPaths
                        : [],
                    },
                    agent: item.agent,
                    workspaceRoot: workspaceSnapshot?.workspaceRoot,
                    fileTree: workspaceSnapshot?.fileTree ?? [],
                    artifacts: artifacts.map((file) => ({ path: file.path, content: file.content })),
                    projectId: body.projectId,
                    threadId: thread.id,
                  });
                  if (!postFlight.passed) {
                    send("error", {
                      message: `${item.agent.name} failed the post-flight gate. ${postFlight.resolutionPath ?? "Artifact verification failed."}`,
                      agentId: item.agent.id,
                      messageId: assistantMessage.id,
                      code: "POST_FLIGHT_BLOCKED",
                    });
                  }
                  const answered: Partial<ChatMessage> = {
                    content: responseText,
                    pending: false,
                    metrics,
                    ...(artifactPaths.length ? { artifacts: artifactPaths } : {}),
                  };
                  await updateThreadMessage(thread.id, assistantMessage.id, answered);
                  send("metrics", {
                    messageId: assistantMessage.id,
                    agentId: item.agent.id,
                    metrics,
                  });
                  send("message", {
                    ...assistantMessage,
                    ...answered,
                  });

                  // A specialist reply is a report, not just a completion signal.
                  // Preserve the full substance in the mesh and explicitly hand it
                  // to the Product Manager for content-first review when enabled.
                  if (postFlight.passed && autoHandoff && supervisor && supervisor.id !== item.agent.id && (visited.get(supervisor.id) ?? 0) < visitCap(supervisor.id) && !scheduled.has(supervisor.id) && !notifiedSupervisor.has(supervisor.id) && item.depth < maxDepth) {
                    notifiedSupervisor.add(supervisor.id);
                    publishAgentEnvelope({
                      from: `@${item.agent.handle.replace(/^@/, "")}`,
                      to: `@${supervisor.handle.replace(/^@/, "")}`,
                      type: "DIRECT_MESSAGE",
                      payload: `${postFlight.summary.summary}\n\n${responseText}`,
                      timestamp: new Date().toISOString(),
                      resolutionPath: "Review the complete specialist response, summarize its concrete findings, and either assign one exact-handle follow-up or record why no follow-up is needed.",
                      fileTree: workspaceSnapshot?.fileTree ?? [],
                      workspaceRoot: workspaceSnapshot?.workspaceRoot,
                      status: "INFO",
                      summary: postFlight.summary,
                    }, { agentId: item.agent.id, targetAgentId: supervisor.id, threadId: thread.id, projectId: body.projectId });
                  }

                  if (artifacts.length) {
                    meshBus.publish({
                      type: "ARTIFACT_CREATED",
                      source: item.agent.name,
                      agentId: item.agent.id,
                      threadId: thread.id,
                      projectId: body.projectId,
                      severity: artifactErrors.length ? "warning" : "info",
                      title: `${item.agent.name} ${writtenArtifacts.length ? "wrote" : "published"} ${artifacts.length} artifact(s)`,
                      message: artifacts.map((file) => file.path).slice(0, 12).join(", "),
                      payload: {
                        files: artifacts.map((file) => ({
                          path: file.path,
                          content: file.content,
                        })),
                        applied: writtenArtifacts,
                        errors: artifactErrors,
                        workspaceRoot: workspaceSnapshot?.workspaceRoot,
                      },
                    });
                    send("artifact", {
                      messageId: assistantMessage.id,
                      agentId: item.agent.id,
                      projectId: body.projectId,
                      files: artifacts.map((file) => file.path),
                      written: writtenArtifacts,
                      errors: artifactErrors,
                    });

                    void (async () => {
                      try {
                        const report = await validateArtifactsOnce(
                          artifacts.map((file) => ({ path: file.path, content: file.content })),
                          {
                            agentId: item.agent.id,
                            threadId: thread.id,
                            projectId: body.projectId,
                            reason: `${item.agent.name} published ${artifacts.length} artifact(s) in chat.`,
                          },
                        );
                        const actionable = report.findings.filter((finding) => finding.severity !== "info");
                        const summary = {
                          reportId: report.id,
                          score: report.score,
                          passed: report.passed && postFlight.passed,
                          findings: actionable.length,
                          topFinding: actionable[0]?.title,
                          postFlightPassed: postFlight.passed,
                        };
                        await updateThreadMessage(thread.id, assistantMessage.id, { validation: summary });
                        try {
                          send("validation", {
                            messageId: assistantMessage.id,
                            agentId: item.agent.id,
                            report,
                            summary,
                          });
                        } catch {}
                        try {
                          send("message", {
                            ...assistantMessage,
                            ...answered,
                            validation: summary,
                          });
                        } catch {}
                      } catch (error) {
                        try {
                          send("error", {
                            message: `Silent Witness could not validate the artifacts: ${
                              error instanceof Error ? error.message : String(error)
                            }`,
                            agentId: item.agent.id,
                          });
                        } catch {}
                      }
                    })();
                  }
                  setMeshAgentStatus(item.agent.id, postFlight.passed ? "idle" : "error", postFlight.passed ? "Response complete" : "Post-flight blocked");
                  meshBus.publish({
                    type: "AGENT_STATUS",
                    source: item.agent.name,
                    agentId: item.agent.id,
                    threadId: thread.id,
                    projectId: body.projectId,
                    severity: postFlight.passed ? "success" : "error",
                    title: postFlight.passed ? `${item.agent.name} is idle` : `${item.agent.name} post-flight blocked`,
                    message: postFlight.passed ? "Response delivered." : postFlight.resolutionPath ?? "Artifact verification failed.",
                    payload: { status: postFlight.passed ? "idle" : "error", detail: postFlight.passed ? "Idle" : "Post-flight blocked" },
                  });

                  if (postFlight.passed && autoHandoff && item.depth < maxDepth) {
                    // Route specialist findings through the manager so the manager
                    // reads the response and chooses the next specialist. If there
                    // is no manager, retain direct exact-handle handoffs.
                    const mentionedTargets = Array.from(
                      new Map(mentionedAgents.map((agent) => [agent.id, agent])).values(),
                    ).filter(
                      (agent) =>
                        (visited.get(agent.id) ?? 0) < visitCap(agent.id) &&
                        !scheduled.has(agent.id),
                    ).map((agent) => routeTask(agents, `${body.message.trim()}\n${responseText}`, agent).agent ?? agent);
                    const candidates = supervisor && supervisor.id !== item.agent.id && (visited.get(supervisor.id) ?? 0) < visitCap(supervisor.id) && !scheduled.has(supervisor.id)
                      ? [supervisor]
                      : mentionedTargets;
                    // Reserve targets synchronously before the first await. Two
                    // specialists in the same wave can otherwise enqueue the same
                    // manager twice and double-bill the next hop.
                    const nextAgents = candidates.filter((agent) => {
                      if ((visited.get(agent.id) ?? 0) >= visitCap(agent.id) || scheduled.has(agent.id)) return false;
                      scheduled.add(agent.id);
                      return true;
                    });

                // Validate every branch together, then enqueue them as a wave.
                const validations = await Promise.all(
                  nextAgents.map(async (nextAgent) => {
                    try {
                      return {
                        nextAgent,
                        verdict: await validateAgentHandoff({
                          sourceAgent: item.agent,
                          targetAgent: nextAgent,
                          payload: responseText,
                          originalRequest: body.message.trim(),
                          traceKey: thread.id,
                          stage: "chat",
                        }),
                      } as const;
                    } catch (error) {
                      return { nextAgent, error } as const;
                    }
                  }),
                );
                for (const validation of validations) {
                  if ("error" in validation) {
                    scheduled.delete(validation.nextAgent.id);
                    const detail = String(validation.error);
                    const resolutionPath = inferResolutionPath(detail);
                    meshBus.publish({
                      type: "VALIDATION_FAILED",
                      source: "Handoff guardrail",
                      agentId: item.agent.id,
                      targetAgentId: validation.nextAgent.id,
                      threadId: thread.id,
                      projectId: body.projectId,
                      severity: "error",
                      title: "Handoff validation failed",
                      message: detail,
                      payload: { resolutionPath, fileTree: workspaceSnapshot?.fileTree ?? [], workspaceRoot: workspaceSnapshot?.workspaceRoot },
                    });
                    publishAgentEnvelope({
                      from: "@handoff-validator",
                      to: `@${validation.nextAgent.handle.replace(/^@/, "")}`,
                      type: "VALIDATION_REPORT",
                      payload: detail,
                      timestamp: new Date().toISOString(),
                      resolutionPath,
                      fileTree: workspaceSnapshot?.fileTree ?? [],
                      workspaceRoot: workspaceSnapshot?.workspaceRoot,
                      status: "FAILED",
                    }, { agentId: item.agent.id, targetAgentId: validation.nextAgent.id, threadId: thread.id, projectId: body.projectId });
                    send("error", { message: `${detail}\nResolution path: ${resolutionPath}` });
                    continue;
                  }
                  const { nextAgent, verdict } = validation;
                      send("guardrail", { result: verdict, from: item.agent.name, to: nextAgent.name });
                      if (verdict.deadLoop.detected) {
                        frozen = true;
                        const resolutionPath = "Break the repeated handoff cycle by assigning one concrete artifact to the best-qualified agent, then resume from that artifact instead of repeating the same transition.";
                        publishAgentEnvelope({
                          from: `@${item.agent.handle.replace(/^@/, "")}`,
                          to: `@${nextAgent.handle.replace(/^@/, "")}`,
                          type: "VALIDATION_REPORT",
                          payload: verdict.deadLoop.message,
                          timestamp: new Date().toISOString(),
                          resolutionPath,
                          fileTree: workspaceSnapshot?.fileTree ?? [],
                          workspaceRoot: workspaceSnapshot?.workspaceRoot,
                          status: "BLOCKED",
                        }, { agentId: item.agent.id, targetAgentId: nextAgent.id, threadId: thread.id, projectId: body.projectId });
                        await learnFromFailure({
                          agent: item.agent,
                          source: "dead-loop",
                          detail: verdict.deadLoop.message,
                          verdict,
                        });
                        send("dead_loop", { result: verdict, deadLoop: verdict.deadLoop });
                        send("error", {
                          message: `${verdict.deadLoop.message}\nResolution path: ${resolutionPath}`,
                          code: "DEAD_LOOP_EXCEPTION",
                        });
                        break;
                      }
                      if (!verdict.passed) {
                        await learnFromFailure({
                          agent: item.agent,
                          source: "guardrail",
                          detail: verdict.errors.join(" ") || "Handoff did not meet the quality threshold.",
                          verdict,
                        });
                      }
                      const correction = verdict.passed ? undefined : correctiveInstruction(verdict);
                      const handoffInputs = writtenArtifacts.length ? writtenArtifacts : [];
                      const compactHandoff = compactAgentContext(responseText, 1_500);
                      const handoffObjective = [
                        managerTask ? `Manager follow-up: ${managerTask}` : "",
                        compactHandoff.text,
                      ].filter(Boolean).join("\n");
                      const nextContract = acceptTask(createTaskContract({
                        sourceAgent: item.agent.name,
                        targetAgent: nextAgent.name,
                        objective: handoffObjective,
                        requiredArtifacts: compactHandoff.artifactPointers,
                        requiredInputs: handoffInputs,
                        requiredCapabilities: scopeHandoffCapabilities(item.agent, handoffObjective),
                        maxTokenBudget: tokenBudgetForTask(handoffObjective),
                      }), nextAgent, {
                        workspaceRoot: workspaceSnapshot?.workspaceRoot,
                        fileTree: workspaceSnapshot?.fileTree ?? [],
                        projectId: body.projectId,
                        threadId: thread.id,
                      });
                      if (nextContract.status !== "ACCEPTED") {
                        scheduled.delete(nextAgent.id);
                        send("error", {
                          message: `${nextAgent.name} could not accept the handoff: ${nextContract.reason ?? "pre-flight readiness failed"}${nextContract.preflight?.resolutionPath ? `\nResolution path: ${nextContract.preflight.resolutionPath}` : ""}`,
                          code: nextContract.status === "BLOCKED" ? "PRE_FLIGHT_BLOCKED" : "TASK_REJECTED",
                        });
                        continue;
                      }
                      publishAgentEnvelope({
                        from: item.agent.handle.startsWith("@") ? item.agent.handle : `@${item.agent.handle}`,
                        to: nextAgent.handle.startsWith("@") ? nextAgent.handle : `@${nextAgent.handle}`,
                        type: "TASK_ASSIGNMENT",
                        payload: `${postFlight.summary.summary}\n\n${nextContract.objective}`,
                        timestamp: new Date().toISOString(),
                        resolutionPath: "Use the attached workspace snapshot, complete the delegated task, and return a concrete fix path if blocked.",
                        fileTree: workspaceSnapshot?.fileTree ?? [],
                        workspaceRoot: workspaceSnapshot?.workspaceRoot,
                        status: "INFO",
                        summary: postFlight.summary,
                      }, { agentId: item.agent.id, targetAgentId: nextAgent.id, threadId: thread.id, projectId: body.projectId });
                      meshBus.publish({
                        type: "HANDOFF",
                        source: item.agent.name,
                        target: nextAgent.name,
                        agentId: item.agent.id,
                        targetAgentId: nextAgent.id,
                        threadId: thread.id,
                        projectId: body.projectId,
                        severity: verdict.passed ? "info" : "warning",
                        title: `${item.agent.name} → ${nextAgent.name}`,
                        message: verdict.passed
                          ? `Peer handoff accepted · guardrail ${verdict.score}/100`
                          : `Peer handoff queued with corrective context · ${verdict.score}/100`,
                        payload: {
                          guardrail: verdict,
                          handle: nextAgent.handle,
                          correction,
                          contract: nextContract,
                          summary: postFlight.summary,
                          resolutionPath: "Use the attached workspace snapshot, complete the delegated objective, and report the exact file/command fix if blocked.",
                          fileTree: workspaceSnapshot?.fileTree ?? [],
                          workspaceRoot: workspaceSnapshot?.workspaceRoot,
                        },
                      });
                      send("handoff", {
                        from: item.agent.name,
                        to: nextAgent.name,
                        handle: nextAgent.handle,
                        reason: verdict.passed
                          ? `Mentioned in ${item.agent.name}'s output · guardrail ${verdict.score}/100`
                          : `Mentioned in ${item.agent.name}'s output · corrective retry (${verdict.score}/100)`,
                        guardrail: verdict,
                        contract: nextContract,
                        score: verdict.score,
                      });
                      queue.push({
                        agent: nextAgent,
                        depth: item.depth + 1,
                        handoff: {
                          from: item.agent.name,
                          output: responseText,
                          correction,
                          score: verdict.score,
                        },
                        contract: nextContract,
                      });
                    }
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const failedTree = workspaceProject ? await listWorkspaceFiles(workspaceProject.workspacePath, 120).catch(() => []) : [];
                  publishAgentEnvelope({
                    from: `@${item.agent.handle.replace(/^@/, "")}`,
                    to: "@chat-operator",
                    type: "VALIDATION_REPORT",
                    payload: message,
                    timestamp: new Date().toISOString(),
                    resolutionPath: inferResolutionPath(message),
                    fileTree: failedTree,
                    workspaceRoot: workspaceProject?.workspacePath,
                    status: "FAILED",
                  }, { agentId: item.agent.id, threadId: thread.id, projectId: body.projectId });
                  await learnFromFailure({
                    agent: item.agent,
                    source: "error",
                    detail: message,
                  });
                  setMeshAgentStatus(item.agent.id, "error", message);
                  await updateThreadMessage(thread.id, assistantMessage.id, {
                    content: `Generation failed: ${message}`,
                    pending: false,
                    error: true,
                  });
                  send("error", { message, agentId: item.agent.id, messageId: assistantMessage.id });
                }
              } catch (error) {
                send("error", {
                  message: error instanceof Error ? error.message : String(error),
                  agentId: item.agent.id,
                });
              }
            }),
          );
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
