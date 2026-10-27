"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  CircleAlert,
  CornerDownRight,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Radio,
  Rocket,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type {
  Agent,
  MeshAgentStatus,
  MeshEvent,
} from "@/lib/types";
import { cn, formatTokens, timeAgo } from "@/lib/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MessageBubble } from "@/components/chat/message-bubble";
import { useChatSession } from "@/components/chat/use-chat-session";

const STATUS_META: Record<
  MeshAgentStatus,
  { label: string; color: string; icon: React.ComponentType<{ className?: string }> }
> = {
  idle: { label: "Idle", color: "text-muted-foreground", icon: Brain },
  thinking: { label: "Thinking", color: "text-factory-cyan", icon: Loader2 },
  communicating: { label: "Communicating", color: "text-factory-lime", icon: Radio },
  validating: { label: "Validating", color: "text-factory-amber", icon: ShieldCheck },
  executing: { label: "Executing", color: "text-factory-amber", icon: Sparkles },
  paused: { label: "Paused", color: "text-muted-foreground", icon: Pause },
  error: { label: "Error", color: "text-red-300", icon: CircleAlert },
};

function agentFor(agents: Agent[], event: MeshEvent): Agent | undefined {
  return (
    agents.find((agent) => agent.id === event.agentId) ??
    agents.find((agent) => agent.name === event.source)
  );
}

function targetAgentFor(agents: Agent[], event: MeshEvent): Agent | undefined {
  return (
    agents.find((agent) => agent.id === event.targetAgentId) ??
    agents.find((agent) => agent.name === event.target)
  );
}

function severityClass(severity: MeshEvent["severity"]): string {
  if (severity === "error") return "border-red-400/25 bg-red-400/[0.04]";
  if (severity === "warning") return "border-factory-amber/25 bg-factory-amber/[0.04]";
  if (severity === "success") return "border-factory-lime/20 bg-factory-lime/[0.03]";
  return "border-border/70 bg-secondary/50";
}

export function MeshEventCard({
  event,
  agents,
  overridden,
  onOverride,
}: {
  event: MeshEvent;
  agents: Agent[];
  overridden: boolean;
  onOverride: () => void;
}) {
  const source = agentFor(agents, event);
  const target = targetAgentFor(agents, event);
  const envelope = event.payload?.envelope && typeof event.payload.envelope === "object"
    ? event.payload.envelope as { from?: unknown; to?: unknown; type?: unknown; resolutionPath?: unknown; workspaceRoot?: unknown; fileTree?: unknown }
    : undefined;
  const isBlock = event.type === "VALIDATION_FAILED" || event.type === "SECURITY_WARNING";
  return (
    <div className={cn("rounded-lg border px-3 py-2.5", severityClass(event.severity))}>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex shrink-0 items-center gap-1">
          <AgentAvatar
            name={source?.name ?? event.source}
            color={source?.color ?? "#f5b544"}
            icon={source?.icon}
            size="sm"
          />
          {target && (
            <>
              <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
              <AgentAvatar
                name={target.name}
                color={target.color}
                icon={target.icon}
                size="sm"
              />
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium">{event.title}</span>
            <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
              {event.type.replaceAll("_", " ")}
            </span>
            <span className="font-mono text-[8px] text-muted-foreground">{timeAgo(event.at)}</span>
            {overridden && <Badge variant="outline" className="text-[8px]">operator override</Badge>}
            {envelope && <>
              <Badge variant="outline" className="font-mono text-[8px]">FROM {String(envelope.from ?? event.source)}</Badge>
              <Badge variant="outline" className="font-mono text-[8px]">TO {String(envelope.to ?? event.target ?? "—")}</Badge>
            </>}
          </div>
          <div className="min-w-0 max-w-full px-1"><p className={cn("mt-1 max-w-full leading-relaxed text-muted-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere]", event.type === "TERMINAL_OUTPUT" && "font-mono text-[9px]")}>
            {event.type === "TERMINAL_OUTPUT" ? `${String(event.payload?.stream ?? "output")}: ${event.message}` : event.message}
          </p></div>
          {typeof event.payload?.resolutionPath === "string" && (
            <p className="mt-1 rounded-md border border-factory-amber/20 bg-factory-amber/[0.04] px-2 py-1 text-[9px] leading-relaxed text-factory-amber/90 break-words [overflow-wrap:anywhere]">
              <span className="font-semibold">Resolution:</span> {event.payload.resolutionPath}
            </p>
          )}
          {Array.isArray(event.payload?.fileTree) && event.payload.fileTree.length > 0 && (
            <details className="mt-1 min-w-0 text-[9px] text-muted-foreground">
              <summary className="cursor-pointer">Workspace snapshot · {event.payload.fileTree.length} files</summary>
              <p className="mt-1 break-all font-mono">{String(event.payload.workspaceRoot ?? "")}</p>
              <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-secondary/50 p-2">{(event.payload.fileTree as string[]).join("\n")}</pre>
            </details>
          )}
          {isBlock && event.requiresOverride && !overridden && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-6 px-2 text-[9px]"
              onClick={onOverride}
            >
              <ShieldCheck className="h-2.5 w-2.5" />
              Override validator block
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentChatMatrix({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const {
    agents,
    projects,
    meshEvents,
    meshStatuses,
    pausedAgentIds,
    overriddenEventIds,
    toggleAgentPause,
    overrideValidator,
  } = useFactory();
  const [input, setInput] = useState("");
  const [projectId, setProjectId] = useState("");
  const [autonomous, setAutonomous] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const {
    threads,
    threadId,
    messages,
    streaming,
    loadThreads,
    newThread,
    send,
    stop,
    saveEditedMessage,
    continueFromEditedMessage,
    sessionTokens,
  } = useChatSession();

  useEffect(() => {
    void loadThreads(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming, meshEvents.length]);

  const liveEvents = useMemo(
    () =>
      meshEvents
        .filter(
          (event) =>
            event.type !== "AGENT_STATUS" &&
            (!event.threadId || !threadId || event.threadId === threadId),
        )
        .slice(-10),
    [meshEvents, threadId],
  );

  const statusOf = (agentId: string): MeshAgentStatus => {
    if (pausedAgentIds.includes(agentId)) return "paused";
    return meshStatuses[agentId]?.status ?? "idle";
  };

  async function submit(messageOverride?: string) {
    const text = (messageOverride ?? input).trim();
    if (!text || streaming) return;
    if (autonomous && !projectId) {
      toast.error("Choose a project for the autonomous pipeline.");
      return;
    }
    setInput("");
    const ok = await send(text, { projectId: projectId || undefined, autonomous });
    if (!ok) setInput(text);
  }

  function startNewThread() {
    if (streaming) return;
    newThread();
    setInput("");
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col gap-3", className)}>
      <section className="panel flex h-full min-h-[420px] min-w-0 max-w-full flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Waypoints className="h-3.5 w-3.5 shrink-0 text-factory-cyan" />
            <span className="truncate text-xs font-medium">Master Chat Matrix</span>
            <Badge variant="outline" className="shrink-0 font-mono text-[9px]">{formatTokens(sessionTokens)} tokens</Badge>
            {threadId && (
              <span className="font-mono text-[9px] text-muted-foreground">
                {threads.find((thread) => thread.id === threadId)?.title ?? threadId}
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={startNewThread}>
            <MessageSquarePlus className="h-3 w-3" />
            New
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-7 w-[180px] text-[10px]">
              <SelectValue placeholder="No project context" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="ml-auto flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
            <Rocket className={cn("h-3 w-3", autonomous ? "text-factory-amber" : "text-muted-foreground")} />
            autonomous
            <Switch
              checked={autonomous}
              onCheckedChange={setAutonomous}
              className="h-4 w-7 [&>span]:h-3 [&>span]:w-3"
            />
          </label>
        </div>

        {!compact && (
          <div className="border-b border-border/60 px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {agents.slice(0, 7).map((agent) => {
                const status = statusOf(agent.id);
                const meta = STATUS_META[status];
                const Icon = meta.icon;
                const paused = pausedAgentIds.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    onClick={() => void toggleAgentPause(agent.id)}
                    className={cn(
                      "group inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[9px] transition-colors",
                      paused
                        ? "border-factory-amber/30 bg-factory-amber/5"
                        : "border-border/70 bg-secondary/50 hover:border-factory-lime/30",
                    )}
                    title={`${meta.label} · ${paused ? "click to resume" : "click to pause"}`}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: agent.color }}
                    />
                    <span className="font-mono">@{agent.handle}</span>
                    <Icon
                      className={cn(
                        "h-2.5 w-2.5",
                        meta.color,
                        status === "thinking" && "animate-spin",
                      )}
                    />
                    {paused ? <Play className="h-2.5 w-2.5" /> : <Pause className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="w-full min-w-0 max-w-full space-y-4 px-3 py-4">
            {!messages.length && (
              <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-factory-lime/20 bg-factory-lime/5">
                  <Users className="h-5 w-5 text-factory-lime" />
                </div>
                <h3 className="text-sm font-semibold">The mesh is listening.</h3>
                <p className="mt-1 max-w-md text-[11px] leading-relaxed text-muted-foreground">
                  Address the workforce with @product, @architect, @developer, @qa or @devops.
                  Mentions fan out to every named specialist and replies appear here as a live
                  dialogue tree.
                </p>
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  {agents.slice(0, 5).map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => setInput((value) => `${value}${value ? " " : ""}@${agent.handle} `)}
                      className="rounded-full border border-border px-2 py-1 font-mono text-[9px] text-muted-foreground hover:text-foreground"
                    >
                      @{agent.handle}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.filter((message) => !message.handoffFrom).map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                streaming={streaming && message.pending}
                onEdit={saveEditedMessage}
                onContinueEdit={continueFromEditedMessage}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        <div className="border-t border-border/60 bg-secondary/50 p-2.5">
          <div className="flex items-end gap-2 rounded-lg border border-border/70 bg-card/50 p-2">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder="Message the mesh… use @handles to fan out to specialists"
              className="max-h-32 min-h-[44px] resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0"
            />
            {streaming ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                onClick={() => stop()}
              >
                Stop
              </Button>
            ) : (
              <Button size="sm" className="h-8" onClick={() => void submit()} disabled={!input.trim()}>
                <Send className="h-3.5 w-3.5" />
                Send
              </Button>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1 font-mono text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <CornerDownRight className="h-2.5 w-2.5" />
              Enter to send · Shift+Enter for newline
            </span>
            <span className="flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5 text-factory-amber" />
              {liveEvents.filter((event) => event.requiresOverride).length} validator alerts
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
