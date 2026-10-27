import { apiError, json, readJson } from "@/lib/api";
import { getAgent, getProject, getSettings, listAgents } from "@/lib/db";
import { meshBus, publishAgentEnvelope, setMeshAgentStatus } from "@/lib/mesh/event-bus";
import { verifyProjectRuntime } from "@/lib/mesh/validators";
import { runRepairCycle } from "@/lib/orchestrator/repair-engine";
import { applyFileBlocks, parseFileBlocks } from "@/lib/orchestrator/parse";
import { healPrompt } from "@/lib/orchestrator/prompts";
import { generateWithAgent } from "@/lib/providers/router";
import { readWorkspaceContext } from "@/lib/workspace";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface VerifyBody {
  projectId?: string;
  agentId?: string;
  runId?: string;
}

function pickAgent(agents: Agent[], agentId?: string): Agent | undefined {
  return (
    (agentId ? agents.find((agent) => agent.id === agentId) : undefined) ??
    agents.find((agent) => agent.enabled && /developer|engineer|implementation/i.test(`${agent.role} ${agent.name}`)) ??
    agents.find((agent) => agent.enabled)
  );
}

/**
 * Runtime automation check. Builds/tests a project workspace and publishes the
 * full transcript to the mesh wire so the Mesh Hub is not limited to SDLC runs.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<VerifyBody>(request);
    if (!body.projectId) throw new Error("projectId is required.");
    const agents = await listAgents();
    const agent = pickAgent(agents, body.agentId);
    if (!agent) throw new Error("No enabled agent is available to own the verification.");
    const liveAgent = (await getAgent(agent.id)) ?? agent;

    meshBus.publish({
      type: "AUTOMATION_STARTED",
      source: "Runtime Automation",
      agentId: liveAgent.id,
      projectId: body.projectId,
      runId: body.runId,
      severity: "info",
      title: `Runtime check started · ${liveAgent.name}`,
      message: "Running the project build, tests, schema validation and startup probe.",
      payload: { agentId: liveAgent.id },
    });
    setMeshAgentStatus(liveAgent.id, "executing", "Runtime automation check");

    try {
      const onOutput = (event: { stream: "stdout" | "stderr"; text: string; command: string }) => {
        meshBus.publish({
          type: "TERMINAL_OUTPUT",
          source: "Runtime Automation",
          agentId: liveAgent.id,
          projectId: body.projectId,
          runId: body.runId,
          severity: event.stream === "stderr" ? "warning" : "info",
          title: `$ ${event.command ?? "command"}`,
          message: event.text,
          payload: { stream: event.stream, command: event.command },
        });
      };
      let result = await verifyProjectRuntime({
        projectId: body.projectId,
        agent: liveAgent,
        runId: body.runId,
        onOutput,
      });

      // Terminal failures enter the same bounded self-healing loop used by the
      // SDLC runtime gate: up to three high-priority repair contracts routed to
      // the responsible developer before the task is considered blocked.
      if (!result.passed) {
        const project = await getProject(body.projectId);
        if (project) {
          const repairCycle = await runRepairCycle({
            project,
            agent: liveAgent,
            runId: body.runId,
            initial: result,
            maxAttempts: Math.min((await getSettings()).maxHealAttempts, 3),
            verify: () =>
              verifyProjectRuntime({
                projectId: project.id,
                agent: liveAgent,
                runId: body.runId,
                onOutput,
              }),
            repair: async (contract, attempt, failure) => {
              const codeContext = await readWorkspaceContext(project.workspacePath, 24_000);
              const evidence = [
                contract.objective,
                failure.detail,
                `\nworkspaceRoot: ${project.workspacePath}`,
              ].join("\n\n");
              const outcome = await generateWithAgent({
                agent: liveAgent,
                messages: healPrompt(liveAgent, project, project.description, evidence, codeContext, attempt),
                purpose: `runtime automation self-heal ${attempt}`,
                projectDir: project.workspacePath,
                runId: body.runId,
                priority: 8,
                maxTokens: Math.min(4_096, liveAgent.maxTokens),
              });
              const files = parseFileBlocks(outcome.result.text);
              if (!files.length) return { appliedFiles: [], detail: "Repair response contained no parseable files." };
              const applied = await applyFileBlocks(project.workspacePath, files);
              return {
                appliedFiles: applied.written,
                detail: applied.errors.length
                  ? applied.errors.map((item) => `${item.path}: ${item.error}`).join("\n")
                  : `Applied ${applied.written.length} repair file(s).`,
              };
            },
          });
          result = repairCycle.runtime;
        }
      }

      const transcript = result.results
        .map((command) => `$ ${command.command} · exit ${command.exitCode}\n${command.stderr || command.stdout}`)
        .join("\n\n")
        .slice(-8_000);
      meshBus.publish({
        type: result.passed ? "AUTOMATION_PASSED" : "AUTOMATION_FAILED",
        source: "Runtime Automation",
        agentId: liveAgent.id,
        projectId: body.projectId,
        runId: body.runId,
        severity: result.passed ? "success" : "error",
        title: result.passed ? "Runtime check passed" : "Runtime check failed",
        message: transcript || result.detail,
        payload: {
          passed: result.passed,
          results: result.results,
          proof: result.proof,
          detail: result.detail,
        },
        requiresOverride: !result.passed,
      });
      setMeshAgentStatus(liveAgent.id, result.passed ? "idle" : "error", result.passed ? "Runtime check passed" : "Runtime check failed");
      if (!result.passed) {
        publishAgentEnvelope({
          from: "@runtime-automation",
          to: `@${liveAgent.handle.replace(/^@/, "")}`,
          type: "VALIDATION_REPORT",
          payload: result.detail.slice(-4_000),
          timestamp: new Date().toISOString(),
          resolutionPath: "Fix the first failing command in the transcript, rerun the automation check, and attach the passing proof.",
          fileTree: [],
          status: "FAILED",
        }, { agentId: liveAgent.id, targetAgentId: liveAgent.id, projectId: body.projectId, runId: body.runId });
      }
      return json({ result, agent: liveAgent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      meshBus.publish({
        type: "AUTOMATION_FAILED",
        source: "Runtime Automation",
        agentId: liveAgent.id,
        projectId: body.projectId,
        runId: body.runId,
        severity: "error",
        title: "Runtime check crashed",
        message,
        payload: {},
        requiresOverride: true,
      });
      setMeshAgentStatus(liveAgent.id, "error", message);
      throw error;
    }
  } catch (error) {
    return apiError(error, 400);
  }
}
