"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  Bot,
  ChevronRight,
  CornerDownRight,
  Cpu,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  Radio,
  Rocket,
  Sparkles,
  Square,
  Trash2,
  Users,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { cn, formatDuration, formatTokens, timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ModelBadge } from "@/components/shared/model-badge";
import { MessageBubble } from "@/components/chat/message-bubble";
import { MeshEventCard } from "@/components/chat/AgentChatMatrix";
import { useChatSession } from "@/components/chat/use-chat-session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";

const SUGGESTIONS = [
  "@product draft a spec for a local-first bookmark manager with tags and search",
  "@architect design the smallest file tree for a CLI expense tracker",
  "@qa write adversarial tests for a password strength validator",
  "@developer implement a rate limiter with a sliding window",
];

export default function ChatPage() {
  const {
    agents,
    projects,
    settings,
    models,
    meshEvents,
    meshStatuses,
    pausedAgentIds,
    overriddenEventIds,
    overrideValidator,
    toggleAgentPause,
  } = useFactory();
  const [input, setInput] = useState("");
  const [autonomous, setAutonomous] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const {
    threads,
    threadId,
    messages,
    streaming,
    handoff,
    sessionTokens,
    loadThreads,
    openThread,
    newThread: resetThread,
    deleteThread,
    send: sendMessage,
    stop,
    saveEditedMessage,
    continueFromEditedMessage,
  } = useChatSession();

  useEffect(() => {
    void loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  const filteredAgents = useMemo(() => {
    if (mentionQuery === null) return [];
    return agents.filter(
      (agent) =>
        agent.enabled &&
        (agent.handle.toLowerCase().includes(mentionQuery) ||
          agent.name.toLowerCase().includes(mentionQuery) ||
          agent.role.toLowerCase().includes(mentionQuery)),
    );
  }, [agents, mentionQuery]);

  function newThread() {
    if (streaming) return;
    resetThread();
    setInput("");
    setMentionQuery(null);
    textareaRef.current?.focus();
  }

  function insertMention(agent: Agent) {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    if (/@([\w-]*)$/.test(before)) {
      setInput(`${before.replace(/@([\w-]*)$/, `@${agent.handle} `)}${after}`);
    } else {
      setInput(`${input}${input.endsWith(" ") || !input ? "" : " "}@${agent.handle} `);
    }
    setMentionQuery(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handleInputChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setInput(value);
    const cursor = event.target.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = before.match(/@([\w-]*)$/);
    setMentionQuery(match ? match[1].toLowerCase() : null);
  }

  async function submit(messageOverride?: string) {
    const message = (messageOverride ?? input).trim();
    if (!message || streaming) return;
    if (autonomous && !projectId) {
      toast.error("Choose a project for the autonomous pipeline.");
      return;
    }
    setInput("");
    setMentionQuery(null);
    const ok = await sendMessage(message, {
      projectId: projectId || undefined,
      autonomous,
    });
    if (!ok) setInput(message);
  }

  const activeThread = threads.find((thread) => thread.id === threadId);
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
  const visibleMessages = useMemo(
    () => messages.filter((message) => !message.handoffFrom),
    [messages],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Multi-agent coordination"
        title="Chat Matrix"
        description="One channel for the whole team. Mention a specialist to route a task, or flip on Autonomous to hand the brief to the full SDLC pipeline."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={newThread} disabled={streaming}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              New chat
            </Button>
            <Button
              variant={autonomous ? "amber" : "secondary"}
              size="sm"
              onClick={() => setAutonomous((value) => !value)}
            >
              <Rocket className="h-3.5 w-3.5" />
              {autonomous ? "Autonomous on" : "Autonomous"}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_250px] xl:grid-cols-[210px_minmax(0,1fr)_250px]">
        <aside className="hidden xl:block">
          <div className="panel flex h-[calc(100vh-12rem)] min-h-[560px] flex-col">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <span className="eyebrow">Threads</span>
              <button
                onClick={newThread}
                className="rounded p-0.5 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                aria-label="New thread"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <ScrollArea className="flex-1">
              <div className="space-y-0.5 p-2">
                {threads.map((thread) => (
                  <div
                    key={thread.id}
                    className={cn(
                      "group flex items-start gap-1 rounded-md px-2 py-2 transition-colors",
                      thread.id === threadId ? "bg-factory-lime/10" : "hover:bg-secondary/50",
                    )}
                  >
                    <button
                      onClick={() => void openThread(thread.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div
                        className={cn(
                          "truncate text-[11px]",
                          thread.id === threadId ? "text-factory-lime" : "text-foreground/85",
                        )}
                      >
                        {thread.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
                        <span>{(thread.directMessageCount ?? thread.messageCount)} msg</span>
                        <span>·</span>
                        <span>{timeAgo(thread.updatedAt)}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => void deleteThread(thread.id)}
                      className="mt-0.5 hidden rounded p-0.5 text-muted-foreground hover:text-red-300 group-hover:block"
                      aria-label="Delete thread"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {!threads.length && (
                  <div className="px-2 py-8 text-center text-[11px] text-muted-foreground">
                    No conversations yet.
                  </div>
                )}
              </div>
            </ScrollArea>
            <div className="border-t border-border/60 p-3">
              <div className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
                <Radio className="h-3 w-3 text-factory-lime" />
                {agents.filter((agent) => agent.enabled).length} agents listening
              </div>
            </div>
          </div>
        </aside>

        <section className="panel flex h-[calc(100vh-12rem)] min-h-[560px] flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-factory-cyan" />
              <span className="truncate text-xs font-medium">
                {activeThread?.title ?? "New conversation"}
              </span>
              {handoff && (
                <Badge variant="info" className="hidden sm:inline-flex">
                  <CornerDownRight className="h-2.5 w-2.5" /> {handoff}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="h-7 w-[150px] font-mono text-[10px]">
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-secondary/50 px-2 py-1">
                <span className="font-mono text-[9px] text-muted-foreground">AUTO</span>
                <Switch checked={autonomous} onCheckedChange={setAutonomous} className="h-4 w-7 [&>span]:h-3 [&>span]:w-3" />
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-4 md:px-4">
            {visibleMessages.length ? (
              <div className="space-y-4">
                {visibleMessages.map((message) => (
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
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-factory-lime/20 bg-factory-lime/5">
                  <Users className="h-5 w-5 text-factory-lime" />
                </div>
                <h3 className="text-lg font-semibold">Talk to the factory.</h3>
                <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                  Mention an agent by handle. Without a mention, the Product Manager triages the
                  request. Autonomous mode delegates the brief to the full five-phase pipeline.
                </p>
                <div className="mt-5 grid w-full max-w-xl gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => {
                        setInput(suggestion);
                        textareaRef.current?.focus();
                      }}
                      className="rounded-lg border border-border/70 bg-secondary/50 px-3 py-2 text-left text-[11px] leading-relaxed text-muted-foreground transition-colors hover:border-factory-lime/30 hover:text-foreground"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
                <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                  {agents.slice(0, 5).map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => insertMention(agent)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 font-mono text-[9px] text-muted-foreground hover:border-factory-lime/30 hover:text-foreground"
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: agent.color }} />
                      @{agent.handle}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="relative border-t border-border/60 bg-secondary/50 p-2.5">
            {mentionQuery !== null && filteredAgents.length > 0 && (
              <div className="absolute bottom-full left-2.5 z-20 mb-1 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
                <div className="border-b border-border/60 px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  Route to agent
                </div>
                {filteredAgents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => insertMention(agent)}
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs">{agent.name}</div>
                      <div className="font-mono text-[9px] text-muted-foreground">@{agent.handle} · {agent.role}</div>
                    </div>
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-lg border border-border/70 bg-card/50 p-2">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMentionQuery(null);
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                rows={2}
                placeholder={
                  autonomous
                    ? "Describe the software to build. The full SDLC pipeline will run…"
                    : "Message the factory… use @product, @architect, @developer, @qa or @devops"
                }
                className="max-h-40 min-h-[44px] resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0"
              />
              <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
                {streaming ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => stop()}
                    className="h-8"
                  >
                    <Square className="h-3 w-3" />
                    Stop
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void submit()} disabled={!input.trim()} className="h-8">
                    {autonomous ? <Rocket className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
                    {autonomous ? "Run" : "Send"}
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-between px-1 font-mono text-[9px] text-muted-foreground">
              <span>
                {autonomous
                  ? "Autonomous · requirements → architecture → code → tests → CI"
                  : "Enter to send · Shift+Enter for newline · @ to route"}
              </span>
              <span className="flex items-center gap-1">
                <Sparkles className="h-2.5 w-2.5 text-factory-lime" />
                {messages.filter((message) => message.role === "assistant").length} agent replies
              </span>
            </div>
          </div>
        </section>

        <aside className="hidden lg:block">
          <div className="panel flex h-[calc(100vh-12rem)] min-h-[560px] flex-col">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <span className="eyebrow">Agent roster</span>
              <Badge variant="outline">{agents.filter((agent) => agent.enabled).length}</Badge>
            </div>
            <ScrollArea className="flex-1">
              <div className="space-y-1 p-2">
                {agents.map((agent) => {
                  const model = models.find((item) => item.key === agent.modelKey);
                  const status = pausedAgentIds.includes(agent.id)
                    ? "paused"
                    : meshStatuses[agent.id]?.status ?? "idle";
                  return (
                    <button
                      key={agent.id}
                      onClick={() => insertMention(agent)}
                      disabled={!agent.enabled}
                      className={cn(
                        "w-full rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-secondary/50",
                        !agent.enabled && "opacity-40",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-medium">{agent.name}</div>
                          <div className="flex items-center gap-1 font-mono text-[8px] text-muted-foreground">
                            <span>@{agent.handle}</span>
                            <span>·</span>
                            <span className={cn(status !== "idle" && "text-factory-cyan")}>{status}</span>
                          </div>
                        </div>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: agent.color }} />
                      </div>
                      <div className="mt-1.5">
                        <ModelBadge model={model} modelKey={agent.modelKey} compact />
                      </div>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
            <div className="space-y-2 border-t border-border/60 p-3">
              <div className="flex items-center justify-between font-mono text-[9px] text-muted-foreground">
                <span className="flex items-center gap-1"><Waypoints className="h-3 w-3" /> Auto-handoff</span>
                <span className={settings?.autoHandoff ? "text-factory-lime" : "text-muted-foreground"}>
                  {settings?.autoHandoff ? "on" : "off"}
                </span>
              </div>
              <div className="flex items-center justify-between font-mono text-[9px] text-muted-foreground">
                <span className="flex items-center gap-1"><CornerDownRight className="h-3 w-3" /> Max depth</span>
                <span>{settings?.maxHandoffDepth ?? 2}</span>
              </div>
              <div className="flex items-center justify-between font-mono text-[9px] text-muted-foreground">
                <span className="flex items-center gap-1"><Cpu className="h-3 w-3" /> VRAM guard</span>
                <span>serialized</span>
              </div>
              <div className="rounded-md border border-border/60 bg-secondary/50 p-2 text-[9px] leading-relaxed text-muted-foreground">
                Mentions route the next turn. Agent replies can mention another specialist to trigger
                an automatic handoff. The payload and original brief travel with the handoff.
              </div>
            </div>
            {liveEvents.length > 0 && (
              <div className="border-t border-border/60 p-2">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="eyebrow">Live mesh events</span>
                  <Link href="/mesh" className="font-mono text-[9px] text-factory-cyan hover:underline">Mesh Hub</Link>
                </div>
                <ScrollArea className="max-h-[260px]">
                  <div className="space-y-1.5">
                    {liveEvents.map((item) => (
                      <MeshEventCard
                        key={item.id}
                        event={item}
                        agents={agents}
                        overridden={overriddenEventIds.includes(item.id)}
                        onOverride={() => void overrideValidator(item.id, item.agentId, "Approved from chat thread.")}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
