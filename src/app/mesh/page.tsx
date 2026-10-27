"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Brain,
  CheckCircle2,
  GitMerge,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type { Agent, AgentAnalytics, AgentMemory, MeshAgentStatus, MeshEvent } from "@/lib/types";
import { cn, formatTokens, timeAgo } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/shared/page-header";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { Metric } from "@/components/shared/metric";
import { AgentChatMatrix, MeshEventCard } from "@/components/chat/AgentChatMatrix";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STATUS_META: Record<
  MeshAgentStatus,
  { label: string; dot: string; text: string; icon: React.ComponentType<{ className?: string }> }
> = {
  idle: { label: "Idle", dot: "bg-muted-foreground", text: "text-muted-foreground", icon: Brain },
  thinking: { label: "Thinking", dot: "bg-factory-cyan", text: "text-factory-cyan", icon: Loader2 },
  communicating: { label: "Communicating", dot: "bg-factory-lime", text: "text-factory-lime", icon: Radio },
  validating: { label: "Validating", dot: "bg-factory-amber", text: "text-factory-amber", icon: ShieldCheck },
  executing: { label: "Executing", dot: "bg-factory-amber", text: "text-factory-amber", icon: Sparkles },
  paused: { label: "Paused", dot: "bg-factory-amber", text: "text-factory-amber", icon: Pause },
  error: { label: "Error", dot: "bg-red-400", text: "text-red-300", icon: AlertTriangle },
};

const WIRE_TYPES = new Set<MeshEvent["type"]>([
  "VALIDATION_STARTED",
  "VALIDATION_PASSED",
  "VALIDATION_FAILED",
  "SECURITY_WARNING",
  "VALIDATION_OVERRIDDEN",
  "NEGOTIATION_STARTED",
  "NEGOTIATION_MESSAGE",
  "NEGOTIATION_RESOLVED",
  "NEGOTIATION_FAILED",
  "MEMORY_CONSTRAINT",
  "HANDOFF",
  "AGENT_ENVELOPE",
  "TASK_CONTRACT",
  "PRE_FLIGHT_BLOCKED",
  "POST_FLIGHT_PASSED",
  "POST_FLIGHT_BLOCKED",
  "SCOPE_ADVISORY",
  "ROUTING_ERROR",
  "TEST_FAILED",
  "ARTIFACT_CREATED",
  "TERMINAL_OUTPUT",
  "AUTOMATION_STARTED",
  "AUTOMATION_PASSED",
  "AUTOMATION_FAILED",
  "CANVAS_RUN_STARTED",
  "CANVAS_RUN_COMPLETED",
]);

interface NegotiationSummary {
  id: string;
  status: "running" | "resolved" | "failed";
  request: { topic: string; leftAgentId: string; rightAgentId: string; autoApply?: boolean };
  rounds: number;
  agreement?: string;
  appliedFiles: string[];
  error?: string;
  messages?: Array<{ id: string; round: number; fromAgent: string; content: string }>;
  startedAt: number;
  completedAt?: number;
}

type WireFilter = "all" | "alerts" | "validation" | "automation" | "handoff";

function eventMatchesFilter(event: MeshEvent, filter: WireFilter): boolean {
  if (filter === "all") return true;
  if (filter === "alerts") return event.severity === "error" || Boolean(event.requiresOverride);
  if (filter === "validation") return event.type.startsWith("VALIDATION") || event.type === "SECURITY_WARNING";
  if (filter === "automation") return event.type.startsWith("AUTOMATION") || event.type.startsWith("CANVAS_RUN");
  return event.type === "HANDOFF" || event.type === "AGENT_ENVELOPE" || event.type === "TASK_CONTRACT";
}

function AgentNodeCard({ agent }: { agent: Agent }) {
  const { meshStatuses, pausedAgentIds, toggleAgentPause, overrideValidator, overriddenEventIds, meshEvents } =
    useFactory();
  const paused = pausedAgentIds.includes(agent.id);
  const status: MeshAgentStatus = paused
    ? "paused"
    : meshStatuses[agent.id]?.status ?? "idle";
  const detail = paused ? "Thread held by operator" : meshStatuses[agent.id]?.detail;
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  const alert = meshEvents
    .slice(-80)
    .some(
      (event) =>
        event.agentId === agent.id &&
        event.requiresOverride &&
        !overriddenEventIds.includes(event.id),
    );
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-secondary/50 p-3 transition-colors",
        alert ? "border-factory-amber/40" : "border-border/70",
      )}
    >
      <div
        className="absolute inset-x-0 top-0 h-px opacity-70"
        style={{ background: `linear-gradient(90deg, transparent, ${agent.color}, transparent)` }}
      />
      <div className="flex items-start gap-2.5">
        <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11px] font-semibold">{agent.name}</span>
            <span className="font-mono text-[8px] text-muted-foreground">@{agent.handle}</span>
          </div>
          <div className={cn("mt-0.5 flex items-center gap-1 font-mono text-[8px]", meta.text)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
            <Icon className={cn("h-2.5 w-2.5", status === "thinking" && "animate-spin")} />
            {meta.label}
          </div>
        </div>
        <button
          onClick={() => void toggleAgentPause(agent.id)}
          className="rounded border border-border/60 p-1 text-muted-foreground transition-colors hover:border-factory-lime/30 hover:text-foreground"
          aria-label={paused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
        >
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </button>
      </div>
      <p className="mt-2 line-clamp-2 min-h-[24px] text-[9px] leading-relaxed text-muted-foreground">
        {detail ?? agent.description}
      </p>
      <div className="mt-2 flex items-center justify-between font-mono text-[8px] text-muted-foreground">
        <span className="truncate">{agent.modelKey.split("/").slice(1).join("/")}</span>
        {alert && (
          <button
            className="text-factory-amber hover:underline"
            onClick={() => {
              const event = meshEvents
                .slice()
                .reverse()
                .find(
                  (item) =>
                    item.agentId === agent.id &&
                    item.requiresOverride &&
                    !overriddenEventIds.includes(item.id),
                );
              if (event) void overrideValidator(event.id, agent.id, "Approved from agent node.");
            }}
          >
            override
          </button>
        )}
      </div>
    </div>
  );
}

function MemoryPanel() {
  const { meshMemory, agents, fetchMeshMemory } = useFactory();
  const [clearing, setClearing] = useState(false);

  async function clearMemory() {
    setClearing(true);
    try {
      await fetch("/api/mesh/memory", { method: "DELETE" });
      await fetchMeshMemory();
      toast.success("Epigenetic memory cleared.");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setClearing(false);
    }
  }

  const constraints = meshMemory.flatMap((memory) =>
    memory.constraints.map((constraint) => ({ memory, constraint })),
  );

  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
        <span className="eyebrow flex items-center gap-1.5">
          <Brain className="h-3 w-3 text-factory-lime" />
          Epigenetic memory
        </span>
        <div className="flex items-center gap-1">
          <Badge variant="outline">{constraints.length}</Badge>
          <button
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            onClick={() => void fetchMeshMemory()}
            aria-label="Refresh memory"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>
      <ScrollArea className="h-52">
        <div className="space-y-1.5 p-2">
          {constraints.slice().reverse().map(({ memory, constraint }) => {
            const agent = agents.find((item) => item.id === memory.agentId);
            return (
              <div key={constraint.id} className="rounded-md border border-border/60 bg-secondary/50 p-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: agent?.color ?? "#c8f169" }}
                  />
                  <span className="truncate text-[10px] font-medium">{agent?.name ?? memory.agentId}</span>
                  <Badge variant="outline" className="text-[7px]">{constraint.source}</Badge>
                  <span className="ml-auto font-mono text-[7px] text-muted-foreground">
                    ×{constraint.hits}
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-[9px] leading-relaxed text-muted-foreground">
                  {constraint.rule}
                </p>
              </div>
            );
          })}
          {!constraints.length && (
            <p className="px-2 py-6 text-center text-[10px] text-muted-foreground">
              No learned constraints yet. Failures and validator feedback will appear here.
            </p>
          )}
        </div>
      </ScrollArea>
      {!!constraints.length && (
        <div className="border-t border-border/60 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-[10px] text-muted-foreground"
            onClick={() => void clearMemory()}
            disabled={clearing}
          >
            {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Clear learned memory
          </Button>
        </div>
      )}
    </section>
  );
}

function NegotiationPanel({ agents }: { agents: Agent[] }) {
  const { projects } = useFactory();
  const [leftAgentId, setLeftAgentId] = useState(agents[0]?.id ?? "");
  const [rightAgentId, setRightAgentId] = useState(agents[1]?.id ?? "");
  const [topic, setTopic] = useState("Reconcile the frontend/backend contract and component props.");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [autoApply, setAutoApply] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [history, setHistory] = useState<NegotiationSummary[]>([]);

  async function refreshHistory() {
    try {
      const res = await fetch("/api/mesh/negotiate", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { negotiations: NegotiationSummary[] };
      setHistory(data.negotiations ?? []);
    } catch {
      // Negotiation history is informational.
    }
  }

  useEffect(() => {
    void refreshHistory();
  }, []);

  useEffect(() => {
    if (!history.some((item) => item.status === "running")) return;
    const timer = setInterval(() => void refreshHistory(), 4_000);
    return () => clearInterval(timer);
  }, [history]);

  useEffect(() => {
    if (!leftAgentId && agents[0]) setLeftAgentId(agents[0].id);
    if (!rightAgentId && agents[1]) setRightAgentId(agents[1].id);
  }, [agents, leftAgentId, rightAgentId]);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  async function launch() {
    if (!leftAgentId || !rightAgentId || !topic.trim()) {
      toast.error("Choose two agents and a reconciliation topic.");
      return;
    }
    if (leftAgentId === rightAgentId) {
      toast.error("Choose two different agents.");
      return;
    }
    setLaunching(true);
    try {
      const res = await fetch("/api/mesh/negotiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leftAgentId,
          rightAgentId,
          topic,
          projectId: projectId || undefined,
          autoApply,
          maxRounds: 3,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Negotiation could not start.");
      toast.success("Peer negotiation dispatched", {
        description: `${data.negotiation.id} is running in the background.`,
      });
      await refreshHistory();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section className="panel p-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow flex items-center gap-1.5">
          <GitMerge className="h-3 w-3 text-factory-cyan" />
          Peer negotiation
        </span>
        <Badge variant="outline">background</Badge>
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">
        Two agents reconcile schema or prop conflicts in a bounded loop, then optionally write the
        resolved files.
      </p>
      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
        <Select value={leftAgentId} onValueChange={setLeftAgentId}>
          <SelectTrigger className="h-7 text-[10px]">
            <SelectValue placeholder="Agent A" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={rightAgentId} onValueChange={setRightAgentId}>
          <SelectTrigger className="h-7 text-[10px]">
            <SelectValue placeholder="Agent B" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Input
        value={topic}
        onChange={(event) => setTopic(event.target.value)}
        className="mt-1.5 h-7 text-[10px]"
        placeholder="What should they reconcile?"
      />
      <div className="mt-1.5 grid grid-cols-[1fr_auto] items-center gap-2">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-7 text-[10px]">
            <SelectValue placeholder="Project context" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
          apply
          <Switch checked={autoApply} onCheckedChange={setAutoApply} className="h-4 w-7 [&>span]:h-3 [&>span]:w-3" />
        </label>
      </div>
      <Button
        size="sm"
        className="mt-2 w-full"
        onClick={() => void launch()}
        disabled={launching || agents.length < 2}
      >
        {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Waypoints className="h-3 w-3" />}
        Start peer negotiation
      </Button>
      {!!history.length && (
        <div className="mt-2.5 space-y-1.5 border-t border-border/60 pt-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
              Recent negotiations
            </span>
            <button
              className="text-[8px] text-muted-foreground hover:text-foreground"
              onClick={() => void refreshHistory()}
            >
              refresh
            </button>
          </div>
          {history.slice(0, 4).map((item) => (
            <div key={item.id} className="rounded border border-border/60 bg-secondary/50 p-2">
              <div className="flex items-center gap-1.5">
                <Badge
                  variant={
                    item.status === "resolved"
                      ? "success"
                      : item.status === "failed"
                        ? "destructive"
                        : "warning"
                  }
                  className="text-[7px]"
                >
                  {item.status}
                </Badge>
                <span className="ml-auto font-mono text-[7px] text-muted-foreground">
                  {item.rounds} round(s)
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">
                {item.request.topic}
              </p>
              {item.agreement && (
                <p className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-factory-lime/90">
                  {item.agreement}
                </p>
              )}
              {item.error && (
                <p className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-red-300">
                  {item.error}
                </p>
              )}
              {!!item.appliedFiles.length && (
                <p className="mt-1 truncate font-mono text-[7px] text-factory-cyan">
                  wrote {item.appliedFiles.join(", ")}
                </p>
              )}
              {!!item.messages?.length && (
                <details className="mt-1 text-[8px] text-muted-foreground">
                  <summary className="cursor-pointer font-mono">transcript · {item.messages.length} message(s)</summary>
                  <div className="mt-1 max-h-32 space-y-1 overflow-auto rounded bg-secondary/50 p-1.5">
                    {item.messages.map((message) => (
                      <p key={message.id} className="break-words">
                        <span className="font-mono text-factory-cyan">r{message.round} {message.fromAgent}:</span>{" "}
                        {message.content}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface AnalyticsPayload {
  generatedAt: number;
  agents: AgentAnalytics[];
  totals: {
    tasksAssigned: number;
    accepted: number;
    rejected: number;
    tokensConsumed: number;
    postFlightPassed: number;
    postFlightFailed: number;
    artifactFiles: number;
    artifactBytes: number;
  };
  cache: { entries: number; hits: number; misses: number; writes: number; bytes: number };
  scratchpads: { agents: number; entries: number; bytes: number };
}

function compactBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function AnalyticsDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAnalytics() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/mesh/analytics", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load contribution analytics.");
      setData(payload as AnalyticsPayload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void loadAnalytics();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="inset-y-0 right-0 left-auto top-0 h-full max-h-none w-full max-w-2xl translate-x-0 translate-y-0 gap-3 overflow-hidden rounded-none border-l p-4 sm:rounded-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-factory-cyan" />
            Agent Performance &amp; Contributions
          </DialogTitle>
          <DialogDescription>
            Assignment, acceptance, post-flight first-pass, token and artifact contribution metrics for every enabled handle.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 px-1 py-5 text-[10px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reconstructing contribution ledger…
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-400/25 bg-red-400/[0.04] px-3 py-2 text-[10px] text-red-300">
            {error}
          </div>
        )}

        {data && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md border border-border/70 bg-secondary/50 p-2.5">
                <p className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">Assigned</p>
                <p className="mt-1 text-sm font-semibold">{data.totals.tasksAssigned}</p>
              </div>
              <div className="rounded-md border border-border/70 bg-secondary/50 p-2.5">
                <p className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">Accepted</p>
                <p className="mt-1 text-sm font-semibold text-factory-lime">{data.totals.accepted}</p>
              </div>
              <div className="rounded-md border border-border/70 bg-secondary/50 p-2.5">
                <p className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">First-pass</p>
                <p className="mt-1 text-sm font-semibold text-factory-cyan">
                  {data.totals.postFlightPassed
                    ? `${Math.round((data.agents.reduce((sum, agent) => sum + agent.firstPasses, 0) / data.totals.postFlightPassed) * 100)}%`
                    : "—"}
                </p>
              </div>
              <div className="rounded-md border border-border/70 bg-secondary/50 p-2.5">
                <p className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">Tokens</p>
                <p className="mt-1 text-sm font-semibold">{formatTokens(data.totals.tokensConsumed)}</p>
              </div>
            </div>

            <div className="flex items-center justify-between px-0.5">
              <p className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
                {data.agents.length} enabled handles · shared cache {data.cache.entries} entries · scratchpads {data.scratchpads.entries}
              </p>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[9px]" onClick={() => void loadAnalytics()}>
                <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
                Refresh
              </Button>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-2 pr-2">
                {data.agents.map((agent) => (
                  <div key={agent.agentId} className="rounded-lg border border-border/70 bg-secondary/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <AgentAvatar name={agent.name} color="#6fe7dd" size="sm" />
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium">{agent.name}</p>
                          <p className="font-mono text-[8px] text-muted-foreground">{agent.handle}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="font-mono text-[8px]">
                          accept {agent.acceptanceRate}%
                        </Badge>
                        <Badge variant={agent.firstPassRate >= 70 ? "success" : agent.firstPassRate > 0 ? "warning" : "outline"} className="font-mono text-[8px]">
                          first-pass {agent.firstPassRate}%
                        </Badge>
                        <Badge variant="outline" className="font-mono text-[8px]">
                          {formatTokens(agent.tokensConsumed)} tok
                        </Badge>
                      </div>
                    </div>

                    <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[9px] sm:grid-cols-4">
                      <div>
                        <p className="text-muted-foreground">Tasks assigned</p>
                        <p className="font-medium">{agent.tasksAssigned}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Accepted / rejected</p>
                        <p className="font-medium">
                          <span className="text-factory-lime">{agent.accepted}</span>
                          <span className="text-muted-foreground"> / </span>
                          <span className="text-factory-amber">{agent.rejected}</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Post-flight pass/fail</p>
                        <p className="font-medium">
                          <span className="text-factory-lime">{agent.postFlightPassed}</span>
                          <span className="text-muted-foreground"> / </span>
                          <span className="text-red-300">{agent.postFlightFailed}</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Artifact contribution</p>
                        <p className="font-medium">
                          {agent.artifactFiles} files · {compactBytes(agent.artifactBytes)}
                        </p>
                      </div>
                    </div>

                    {agent.artifactPaths.length > 0 && (
                      <details className="mt-2 text-[8px] text-muted-foreground">
                        <summary className="cursor-pointer font-mono">
                          {agent.artifactPaths.length} contributed pointer{agent.artifactPaths.length === 1 ? "" : "s"}
                        </summary>
                        <p className="mt-1 break-all font-mono leading-relaxed">{agent.artifactPaths.join(", ")}</p>
                      </details>
                    )}
                    {agent.lastActivityAt > 0 && (
                      <p className="mt-1.5 font-mono text-[8px] text-muted-foreground">
                        last activity {timeAgo(agent.lastActivityAt)}
                      </p>
                    )}
                  </div>
                ))}
                {!data.agents.length && (
                  <p className="py-8 text-center text-[10px] text-muted-foreground">
                    No enabled agents are available to measure.
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function MeshPage() {
  const {
    agents,
    projects,
    meshEvents,
    meshStatuses,
    pausedAgentIds,
    overriddenEventIds,
    meshConnected,
    meshMemory,
    fetchMeshMemory,
    overrideValidator,
    resetMeshControls,
    toggleAgentPause,
  } = useFactory();
  const [scanning, setScanning] = useState(false);
  const [checkingRuntime, setCheckingRuntime] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [wireFilter, setWireFilter] = useState<WireFilter>("all");
  const [wireQuery, setWireQuery] = useState("");
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const activeAgents = agents.filter((agent) => {
    if (pausedAgentIds.includes(agent.id)) return false;
    const status = meshStatuses[agent.id]?.status;
    return status === "thinking" || status === "communicating" || status === "validating" || status === "executing";
  }).length;
  const alerts = meshEvents.filter(
    (event) => event.requiresOverride && !overriddenEventIds.includes(event.id),
  ).length;
  const constraints = meshMemory.reduce((sum, memory) => sum + memory.constraints.length, 0);
  const wire = useMemo(() => {
    const query = wireQuery.trim().toLowerCase();
    return meshEvents
      .filter((event) => WIRE_TYPES.has(event.type))
      .filter((event) => eventMatchesFilter(event, wireFilter))
      .filter(
        (event) =>
          !query ||
          `${event.title} ${event.message} ${event.source} ${event.target ?? ""} ${event.type}`
            .toLowerCase()
            .includes(query),
      )
      .slice(-40)
      .reverse();
  }, [meshEvents, wireFilter, wireQuery]);

  async function scanWorkspace() {
    if (!projectId) {
      toast.error("Create or select a project first.");
      return;
    }
    setScanning(true);
    try {
      const res = await fetch("/api/mesh/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, scanWorkspace: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Validation failed.");
      toast[data.report.passed ? "success" : "warning"](
        `Silent Witness ${data.report.score}/100`,
        { description: `${data.report.findings.length} finding(s) across the workspace.` },
      );
      await fetchMeshMemory();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setScanning(false);
    }
  }

  async function runAutomationCheck() {
    if (!projectId) {
      toast.error("Create or select a project first.");
      return;
    }
    setCheckingRuntime(true);
    try {
      const res = await fetch("/api/mesh/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Runtime check failed.");
      toast[data.result.passed ? "success" : "warning"](
        data.result.passed ? "Runtime automation passed" : "Runtime automation failed",
        {
          description: `${data.result.results.length} command(s) run · ${
            data.agent?.name ?? "runtime"
          } owns the proof.`,
        },
      );
      await fetchMeshMemory();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setCheckingRuntime(false);
    }
  }

  async function pauseAllAgents() {
    const active = agents.filter(
      (agent) => agent.enabled && !pausedAgentIds.includes(agent.id),
    );
    for (const agent of active) {
      await toggleAgentPause(agent.id);
    }
    if (active.length) toast.success(`Paused ${active.length} agent thread(s).`);
  }

  async function resetControls() {
    await resetMeshControls();
    toast.success("Mesh controls reset", {
      description: "All agents resumed and validator overrides cleared.",
    });
  }


  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        eyebrow="Asynchronous agent mesh"
        title="Autonomous Command Center"
        description="Agents publish events, learn constraints from failure and reconcile peer contracts in the background. The Silent Witness reviews artifacts without blocking the factory."
        actions={
          <>
            <span className="live-dot" aria-hidden title={meshConnected ? "mesh live" : "reconnecting"} />
            <Button variant="outline" size="sm" asChild>
              <Link href="/chat">
                Full chat
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
            <Button size="sm" onClick={() => void scanWorkspace()} disabled={scanning}>
              {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
              Scan workspace
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runAutomationCheck()}
              disabled={checkingRuntime || !projectId}
            >
              {checkingRuntime ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Activity className="h-3.5 w-3.5" />
              )}
              Runtime check
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAnalyticsOpen(true)}>
              <BarChart3 className="h-3.5 w-3.5" />
              Performance
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void resetControls()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Reset controls
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="panel p-4">
          <Metric
            label="Live agents"
            value={activeAgents}
            sub={`${agents.filter((agent) => agent.enabled).length} enabled · ${pausedAgentIds.length} paused`}
          />
        </div>
        <div className="panel p-4">
          <Metric
            label="Mesh wire"
            value={meshConnected ? "online" : "reconnecting"}
            sub={`${meshEvents.length} buffered events`}
            accent={meshConnected ? "#c8f169" : "#f5b544"}
          />
        </div>
        <div className="panel p-4">
          <Metric
            label="Validator alerts"
            value={alerts}
            sub={`${overriddenEventIds.length} operator overrides`}
            accent={alerts ? "#f5b544" : "#6fe7dd"}
          />
        </div>
        <div className="panel p-4">
          <Metric label="Learned rules" value={constraints} sub="epigenetic constraints" accent="#a78bfa" />
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(220px,260px)_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)_330px]">
        <aside className="min-w-0 space-y-3">
          <section className="panel p-3">
            <SectionLabel
              action={
                <span className="flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
                  <button
                    onClick={() => void pauseAllAgents()}
                    className="rounded border border-border/60 px-1 py-0.5 hover:text-foreground"
                    title="Pause every enabled agent"
                  >
                    pause all
                  </button>
                  <Radio className="h-2.5 w-2.5 text-factory-lime" />
                  {meshConnected ? "live" : "sync"}
                </span>
              }
            >
              Agent nodes
            </SectionLabel>
            <div className="space-y-2">
              {agents.map((agent) => (
                <AgentNodeCard key={agent.id} agent={agent} />
              ))}
              {!agents.length && (
                <p className="px-1 py-6 text-center text-[10px] text-muted-foreground">
                  No agents configured.
                </p>
              )}
            </div>
          </section>
          <section className="panel p-3">
            <SectionLabel>Workspace scan</SectionLabel>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="h-7 text-[10px]">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2 w-full"
              onClick={() => void scanWorkspace()}
              disabled={scanning}
            >
              {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
              Run Silent Witness
            </Button>
            <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
              Scans code, tests and security signals with a lightweight local critic when one is
              online, then falls back to deterministic checks.
            </p>
          </section>
        </aside>

        <AgentChatMatrix className="h-[min(72vh,820px)] min-h-[420px] min-w-0" />

        <aside className="min-w-0 space-y-3 xl:col-span-2 2xl:col-span-1">
          <section className="panel flex min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <span className="eyebrow flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-factory-amber" />
                Silent Witness wire
              </span>
              <Badge variant={alerts ? "warning" : "success"}>{alerts ? `${alerts} alerts` : "clear"}</Badge>
            </div>
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
              <Input
                value={wireQuery}
                onChange={(event) => setWireQuery(event.target.value)}
                placeholder="Search the wire…"
                className="h-6 flex-1 text-[9px]"
              />
              <Select value={wireFilter} onValueChange={(value) => setWireFilter(value as WireFilter)}>
                <SelectTrigger className="h-6 w-[105px] text-[9px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All events</SelectItem>
                  <SelectItem value="alerts">Alerts</SelectItem>
                  <SelectItem value="validation">Validation</SelectItem>
                  <SelectItem value="automation">Automation</SelectItem>
                  <SelectItem value="handoff">Handoffs</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ScrollArea className="h-[358px]">
              <div className="space-y-2 p-2">
                {wire.map((event) => (
                  <MeshEventCard
                    key={event.id}
                    event={event}
                    agents={agents}
                    overridden={overriddenEventIds.includes(event.id)}
                    onOverride={() =>
                      void overrideValidator(event.id, event.agentId, "Approved from mesh HUD.")
                    }
                  />
                ))}
                {!wire.length && (
                  <div className="px-2 py-10 text-center">
                    <CheckCircle2 className="mx-auto h-5 w-5 text-factory-lime/70" />
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      The wire is quiet. Run a handoff or scan a workspace to wake the Witness.
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </section>
          <MemoryPanel />
          <NegotiationPanel agents={agents} />
        </aside>
      </div>
      <AnalyticsDrawer open={analyticsOpen} onOpenChange={setAnalyticsOpen} />
    </div>
  );
}
