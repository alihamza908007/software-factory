"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Cloud,
  Cpu,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Terminal,
  Timer,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type { PhaseId, PhaseState, Run, RunStatus } from "@/lib/types";
import { PHASES, SDLC_PHASE_META } from "@/lib/constants";
import { cn, formatDuration, formatMB, timeAgo, truncate } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPill } from "@/components/shared/status";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ModelBadge } from "@/components/shared/model-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { launchRunDialog } from "@/components/shared/run-launcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

const PHASE_ORDER: PhaseId[] = ["requirements", "architecture", "implementation", "testing", "deployment"];

export default function PipelinePage() {
  const { runs, agents, models, fetchRuns, resources } = useFactory();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [tab, setTab] = useState("kanban");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "passed" | "failed">("all");
  const [expanded, setExpanded] = useState<PhaseId | null>("implementation");
  const queryApplied = useRef(false);

  useEffect(() => {
    if (!runs.length) return;
    if (!queryApplied.current) {
      const queryRun = new URLSearchParams(window.location.search).get("run");
      queryApplied.current = true;
      if (queryRun && runs.some((item) => item.id === queryRun)) {
        setSelectedId(queryRun);
        return;
      }
    }
    if (!selectedId) setSelectedId(runs[0].id);
  }, [runs, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/runs/${selectedId}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "Run not found.");
        return (await res.json()) as { run: Run };
      })
      .then((data) => {
        if (!cancelled) setRun(data.run);
      })
      .catch((error) => toast.error(String(error)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const source = new EventSource(`/api/runs/${selectedId}/events`);
    const parse = (event: MessageEvent) => {
      try {
        return JSON.parse(event.data);
      } catch {
        return null;
      }
    };
    source.addEventListener("snapshot", (event) => {
      const data = parse(event);
      if (data?.run) setRun(data.run);
    });
    source.addEventListener("phase", (event) => {
      const data = parse(event);
      if (data?.phase) {
        setRun((prev) =>
          prev
            ? {
                ...prev,
                phases: prev.phases.map((phase) => (phase.id === data.phase.id ? data.phase : phase)),
              }
            : prev,
        );
      }
    });
    source.addEventListener("log", (event) => {
      const data = parse(event);
      if (data?.phaseId && data?.log) {
        setRun((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            phases: prev.phases.map((phase) =>
              phase.id === data.phaseId
                ? phase.logs.some((log) => log.id === data.log.id)
                  ? phase
                  : { ...phase, logs: [...phase.logs, data.log] }
                : phase,
            ),
          };
        });
      }
    });
    source.addEventListener("status", (event) => {
      const data = parse(event);
      if (data?.status) {
        setRun((prev) =>
          prev ? { ...prev, status: data.status, currentPhase: data.currentPhase } : prev,
        );
      }
    });
    source.addEventListener("heal", (event) => {
      const data = parse(event);
      if (data?.attempt) {
        setRun((prev) =>
          prev
            ? {
                ...prev,
                phases: prev.phases.map((phase) =>
                  phase.id === "testing"
                    ? {
                        ...phase,
                        healAttempts: phase.healAttempts.some(
                          (attempt) => attempt.attempt === data.attempt.attempt,
                        )
                          ? phase.healAttempts
                          : [...phase.healAttempts, data.attempt],
                      }
                    : phase,
                ),
              }
            : prev,
        );
      }
    });
    source.addEventListener("artifact", (event) => {
      const data = parse(event);
      if (data?.artifacts) {
        setRun((prev) => (prev ? { ...prev, artifacts: data.artifacts } : prev));
      }
    });
    source.addEventListener("done", (event) => {
      const data = parse(event);
      if (data?.status) {
        setRun((prev) => (prev ? { ...prev, status: data.status } : prev));
      }
      source.close();
      void fetchRuns();
      void fetch(`/api/runs/${selectedId}`, { cache: "no-store" })
        .then((res) => res.json())
        .then((payload: { run: Run }) => setRun(payload.run))
        .catch(() => undefined);
    });
    source.addEventListener("error", (event) => {
      const data = parse(event as MessageEvent);
      if (data?.message) toast.error(data.message);
    });
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const filteredRuns = useMemo(() => {
    if (filter === "all") return runs;
    if (filter === "active") return runs.filter((item) => ["running", "queued"].includes(item.status));
    return runs.filter((item) => item.status === filter);
  }, [runs, filter]);

  const phases = run?.phases ?? [];
  const completed = phases.filter((phase) => phase.status === "passed").length;
  const pr = run?.artifacts.pr;
  const commitCount = run?.git.commits.length ?? 0;
  const heals = phases.reduce((sum, phase) => sum + phase.healAttempts.length, 0);
  const running = run?.status === "running" || run?.status === "queued";

  async function cancelRun() {
    if (!run) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${run.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.message("Cancellation requested.");
      await fetchRuns();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function rerun(phaseId: PhaseId) {
    if (!run) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${run.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rerun", phaseId }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success(`Re-running ${phaseId}…`);
      await fetchRuns();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Autonomous execution"
        title="SDLC Pipeline"
        description="Five phases, one continuous thread. Every phase commits to a feature branch; failures are scraped, dispatched back to the developer and re-verified until the build converges."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void fetchRuns()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => launchRunDialog()}>
              <Plus className="h-3.5 w-3.5" />
              New run
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden xl:block">
          <div className="panel flex h-[calc(100vh-13rem)] min-h-[560px] flex-col">
            <div className="border-b border-border/60 px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="eyebrow">Runs</span>
                <Badge variant="outline">{runs.length}</Badge>
              </div>
              <div className="flex gap-1">
                {(["all", "active", "passed", "failed"] as const).map((value) => (
                  <button
                    key={value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider transition-colors",
                      filter === value
                        ? "bg-factory-lime/10 text-factory-lime"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
            <ScrollArea className="flex-1">
              <div className="space-y-0.5 p-2">
                {filteredRuns.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={cn(
                      "w-full rounded-md border border-transparent px-2 py-2 text-left transition-colors",
                      item.id === selectedId
                        ? "border-factory-lime/20 bg-factory-lime/10"
                        : "hover:bg-white/5",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          item.status === "running"
                            ? "animate-pulse bg-factory-lime"
                            : item.status === "passed"
                              ? "bg-factory-lime/60"
                              : item.status === "failed"
                                ? "bg-factory-red"
                                : "bg-white/20",
                        )}
                      />
                      <span className="truncate font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
                        {item.projectName}
                      </span>
                      <span className="ml-auto font-mono text-[8px] text-muted-foreground/60">
                        {timeAgo(item.updatedAt)}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-foreground/85">
                      {truncate(item.prompt, 80)}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
                      <span>{item.phases.filter((phase) => phase.status === "passed").length}/5</span>
                      <span>·</span>
                      <span>{item.status}</span>
                    </div>
                  </button>
                ))}
                {!filteredRuns.length && (
                  <div className="px-2 py-8 text-center text-[11px] text-muted-foreground">
                    No runs in this filter.
                  </div>
                )}
              </div>
            </ScrollArea>
            <div className="border-t border-border/60 p-3">
              <Button size="sm" className="w-full" onClick={() => launchRunDialog()}>
                <Plus className="h-3.5 w-3.5" />
                Launch run
              </Button>
            </div>
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          {run ? (
            <>
              <section className="panel overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={run.status} />
                      <Badge variant="outline">{run.projectName}</Badge>
                      <span className="font-mono text-[10px] text-muted-foreground">{run.id}</span>
                    </div>
                    <h3 className="mt-2 max-w-3xl text-lg font-semibold leading-snug tracking-tight">
                      {run.prompt}
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <GitBranch className="h-3 w-3" />
                        {run.git.branch ?? "branch pending"}
                      </span>
                      <span className="flex items-center gap-1">
                        <GitCommitHorizontal className="h-3 w-3" />
                        {commitCount} commits
                      </span>
                      <span className="flex items-center gap-1">
                        <Wrench className="h-3 w-3" />
                        {heals} heals
                      </span>
                      <span className="flex items-center gap-1">
                        <FileCode2 className="h-3 w-3" />
                        {run.artifacts.fileTree.length} files
                      </span>
                      {pr?.url && (
                        <a href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-factory-cyan hover:underline">
                          <GitPullRequest className="h-3 w-3" />
                          PR #{pr.number}
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {running ? (
                      <Button variant="destructive" size="sm" onClick={cancelRun} disabled={busy}>
                        <XCircle className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => rerun("testing")}
                          disabled={busy}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Re-test
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => rerun("implementation")}
                          disabled={busy}
                        >
                          <Play className="h-3.5 w-3.5" />
                          Rebuild
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 divide-x divide-border/50 border-b border-border/50 sm:grid-cols-4">
                  <div className="p-3">
                    <div className="eyebrow">Phase</div>
                    <div className="font-mono text-lg">
                      {completed}
                      <span className="text-xs text-muted-foreground">/5</span>
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="eyebrow">Elapsed</div>
                    <div className="font-mono text-lg">
                      {run.startedAt
                        ? formatDuration((run.completedAt ?? Date.now()) - run.startedAt)
                        : "—"}
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="eyebrow">Tests</div>
                    <div className="font-mono text-lg">
                      {run.phases.find((phase) => phase.id === "testing")?.status === "passed" ? (
                        <span className="text-factory-lime">passing</span>
                      ) : run.phases.find((phase) => phase.id === "testing")?.status === "failed" ? (
                        <span className="text-red-300">failing</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="eyebrow">Pull request</div>
                    <div className="font-mono text-lg">
                      {pr?.status === "created" ? (
                        <span className="text-factory-cyan">#{pr.number}</span>
                      ) : pr?.status === "failed" ? (
                        <span className="text-red-300">failed</span>
                      ) : pr?.status === "skipped" ? (
                        <span className="text-muted-foreground">local</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 overflow-x-auto p-3">
                  {PHASES.map((phase, index) => {
                    const state = phases.find((item) => item.id === phase.id);
                    const meta = SDLC_PHASE_META[phase.id];
                    return (
                      <div key={phase.id} className="flex min-w-0 flex-1 items-center gap-2">
                        <div
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
                            state?.status === "passed"
                              ? "border-factory-lime/40 bg-factory-lime/10 text-factory-lime"
                              : state?.status === "running"
                                ? "border-factory-amber/40 bg-factory-amber/10 text-factory-amber"
                                : state?.status === "failed"
                                  ? "border-red-400/40 bg-red-400/10 text-red-300"
                                  : "border-border text-muted-foreground",
                          )}
                        >
                          {state?.status === "passed" ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : state?.status === "failed" ? (
                            <XCircle className="h-3.5 w-3.5" />
                          ) : state?.status === "running" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            index + 1
                          )}
                        </div>
                        <div className="min-w-0 hidden sm:block">
                          <div className="truncate font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                            {meta.short}
                          </div>
                          <div className="truncate text-[10px]">{phase.name}</div>
                        </div>
                        {index < PHASES.length - 1 && <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/30" />}
                      </div>
                    );
                  })}
                </div>
              </section>

              {run.error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-400/5 px-3 py-2.5 text-xs text-red-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">Run failed</div>
                    <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-red-200/80">{run.error}</div>
                  </div>
                </div>
              )}

              <Tabs value={tab} onValueChange={setTab}>
                <div className="flex items-center justify-between">
                  <TabsList>
                    <TabsTrigger value="kanban">Kanban</TabsTrigger>
                    <TabsTrigger value="timeline">Timeline</TabsTrigger>
                    <TabsTrigger value="logs">Live logs</TabsTrigger>
                  </TabsList>
                  <div className="flex items-center gap-2 font-mono text-[9px] text-muted-foreground">
                    <span className={cn("h-1.5 w-1.5 rounded-full", running ? "animate-pulse bg-factory-lime" : "bg-white/20")} />
                    {running ? "streaming" : "snapshot"}
                    <span>·</span>
                    <span>{resources?.heavyRunning ?? 0} local generations</span>
                  </div>
                </div>

                <TabsContent value="kanban">
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {PHASES.map((phase) => (
                      <PhaseColumn
                        key={phase.id}
                        phaseId={phase.id}
                        phase={phases.find((item) => item.id === phase.id)}
                        run={run}
                        agents={agents}
                        models={models}
                        onInspect={(id) => {
                          setExpanded(id);
                          setTab("timeline");
                        }}
                      />
                    ))}
                  </div>
                </TabsContent>

                <TabsContent value="timeline">
                  <div className="panel divide-y divide-border/50 overflow-hidden">
                    {PHASES.map((phase, index) => {
                      const state = phases.find((item) => item.id === phase.id);
                      const agent = agents.find((item) => item.id === state?.agentId);
                      const isOpen = expanded === phase.id;
                      return (
                        <div key={phase.id}>
                          <button
                            onClick={() => setExpanded(isOpen ? null : phase.id)}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
                          >
                            <div className="flex w-6 shrink-0 flex-col items-center">
                              <span
                                className={cn(
                                  "flex h-6 w-6 items-center justify-center rounded-full border font-mono text-[9px]",
                                  state?.status === "passed"
                                    ? "border-factory-lime/40 bg-factory-lime/10 text-factory-lime"
                                    : state?.status === "running"
                                      ? "border-factory-amber/40 bg-factory-amber/10 text-factory-amber"
                                      : state?.status === "failed"
                                        ? "border-red-400/40 bg-red-400/10 text-red-300"
                                        : "border-border text-muted-foreground",
                                )}
                              >
                                {state?.status === "passed" ? <CheckCircle2 className="h-3 w-3" /> : index + 1}
                              </span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-medium">{phase.name}</span>
                                <StatusPill status={state?.status ?? "pending"} kind="phase" />
                                {agent && (
                                  <span className="inline-flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
                                    <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="sm" className="h-4 w-4 text-[7px]" />
                                    {agent.name}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 flex items-center gap-3 font-mono text-[9px] text-muted-foreground">
                                <span>{state?.logs.length ?? 0} log lines</span>
                                <span>{state?.artifacts.length ?? 0} artifacts</span>
                                {!!state?.healAttempts.length && (
                                  <span className="text-factory-amber">{state.healAttempts.length} heals</span>
                                )}
                                {state?.startedAt && (
                                  <span>
                                    {formatDuration((state.completedAt ?? Date.now()) - state.startedAt)}
                                  </span>
                                )}
                              </div>
                            </div>
                            <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
                          </button>
                          {isOpen && state && (
                            <div className="border-t border-border/40 bg-black/20 px-4 py-3">
                              <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{phase.description}</p>
                              {!!state.artifacts.length && (
                                <div className="mb-3 flex flex-wrap gap-1.5">
                                  {state.artifacts.map((artifact) => (
                                    <Badge key={artifact} variant="outline">
                                      <FileCode2 className="h-2.5 w-2.5" /> {artifact}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              {!!state.healAttempts.length && (
                                <div className="mb-3 space-y-2">
                                  {state.healAttempts.map((attempt) => (
                                    <div
                                      key={attempt.attempt}
                                      className={cn(
                                        "rounded-lg border p-2.5",
                                        attempt.result === "passed"
                                          ? "border-factory-lime/20 bg-factory-lime/5"
                                          : "border-red-400/20 bg-red-400/5",
                                      )}
                                    >
                                      <div className="flex items-center gap-2 text-[11px]">
                                        <Wrench className="h-3 w-3 text-factory-amber" />
                                        <span className="font-medium">Self-heal #{attempt.attempt}</span>
                                        <Badge variant={attempt.result === "passed" ? "success" : "destructive"}>
                                          {attempt.result}
                                        </Badge>
                                        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                                          {attempt.agentName} · {attempt.modelKey}
                                        </span>
                                      </div>
                                      <div className="mt-1 font-mono text-[9px] text-muted-foreground">
                                        {attempt.appliedFiles.join(", ") || "no files applied"}
                                      </div>
                                      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
                                        {attempt.failureSummary}
                                      </pre>
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-lg border border-border/50 bg-black/30 p-2.5 font-mono">
                                {state.logs.slice(-30).map((log) => (
                                  <div key={log.id} className="flex gap-2 text-[10px] leading-relaxed">
                                    <span
                                      className={cn(
                                        "mt-1 h-1 w-1 shrink-0 rounded-full",
                                        log.level === "error"
                                          ? "bg-factory-red"
                                          : log.level === "success"
                                            ? "bg-factory-lime"
                                            : log.level === "warn"
                                              ? "bg-factory-amber"
                                              : log.level === "command"
                                                ? "bg-factory-cyan"
                                                : "bg-white/25",
                                      )}
                                    />
                                    <div className="min-w-0">
                                      <div className="text-foreground/80">{log.message}</div>
                                      {log.detail && (
                                        <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-[9px] text-muted-foreground">
                                          {truncate(log.detail, 1200)}
                                        </pre>
                                      )}
                                    </div>
                                  </div>
                                ))}
                                {!state.logs.length && (
                                  <div className="py-4 text-center text-[10px] text-muted-foreground">
                                    No logs yet.
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </TabsContent>

                <TabsContent value="logs">
                  <AllLogs run={run} />
                </TabsContent>
              </Tabs>

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="panel p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="eyebrow">Git orchestration</span>
                    <Badge variant={run.git.pushed ? "success" : run.git.branch ? "info" : "outline"}>
                      {run.git.pushed ? "pushed" : run.git.branch ? "local branch" : "pending"}
                    </Badge>
                  </div>
                  <div className="grid gap-2 font-mono text-[10px]">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Branch</span>
                      <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" /> {run.git.branch ?? "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Base</span>
                      <span>{run.git.baseBranch ?? "main"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Remote</span>
                      <span className="max-w-[240px] truncate">{run.git.remote ?? "not configured"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Dirty files</span>
                      <span>{run.git.dirtyFiles}</span>
                    </div>
                    {run.git.pushError && (
                      <div className="rounded border border-red-400/20 bg-red-400/5 p-2 text-[9px] text-red-200">
                        {run.git.pushError}
                      </div>
                    )}
                  </div>
                  <Separator className="my-3" />
                  <div className="max-h-40 space-y-1.5 overflow-y-auto">
                    {run.git.commits.map((commit) => (
                      <div key={commit.hash} className="flex items-start gap-2 font-mono text-[9px]">
                        <span className="text-factory-lime">{commit.hash}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{commit.message}</span>
                        <span className="text-muted-foreground/50">{timeAgo(commit.at)}</span>
                      </div>
                    ))}
                    {!run.git.commits.length && (
                      <div className="text-[10px] text-muted-foreground">No commits yet.</div>
                    )}
                  </div>
                </section>

                <section className="panel p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="eyebrow">Artifacts & deployment</span>
                    <Badge variant={pr?.status === "created" ? "success" : pr?.status === "failed" ? "destructive" : "outline"}>
                      {pr?.status ?? "local"}
                    </Badge>
                  </div>
                  <div className="grid gap-2 text-[10px]">
                    <ArtifactRow label="Specification" path="docs/SPEC.md" exists={run.phases.find((phase) => phase.id === "requirements")?.artifacts.includes("docs/SPEC.md") ?? false} />
                    <ArtifactRow label="Architecture" path="docs/ARCHITECTURE.md" exists={run.phases.find((phase) => phase.id === "architecture")?.artifacts.includes("docs/ARCHITECTURE.md") ?? false} />
                    <ArtifactRow label="CI workflow" path={run.artifacts.workflowPath ?? ".github/workflows/main.yml"} exists={Boolean(run.artifacts.workflowPath)} />
                    <ArtifactRow label="Deployment notes" path="docs/DEPLOYMENT.md" exists={run.artifacts.fileTree.includes("docs/DEPLOYMENT.md")} />
                  </div>
                  {pr?.url ? (
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 flex items-center justify-between rounded-lg border border-factory-cyan/20 bg-factory-cyan/5 px-3 py-2 text-[11px] text-factory-cyan hover:bg-factory-cyan/10"
                    >
                      <span className="flex items-center gap-2"><GitPullRequest className="h-3.5 w-3.5" /> Pull request #{pr.number}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <div className="mt-3 rounded-lg border border-border/60 bg-black/20 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
                      {pr?.error ?? "Configure GitHub in Settings to push the branch and draft a pull request."}
                    </div>
                  )}
                  {run.artifacts.summary && (
                    <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{run.artifacts.summary}</p>
                  )}
                </section>
              </div>

              <section className="panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="eyebrow">Workspace files</span>
                  <Badge variant="outline">{run.artifacts.fileTree.length}</Badge>
                </div>
                <div className="grid max-h-52 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto font-mono text-[9px] text-muted-foreground sm:grid-cols-3 lg:grid-cols-4">
                  {run.artifacts.fileTree.map((file) => (
                    <div key={file} className="flex items-center gap-1.5 truncate">
                      <FileCode2 className="h-2.5 w-2.5 shrink-0 text-factory-cyan/70" />
                      <span className="truncate">{file}</span>
                    </div>
                  ))}
                  {!run.artifacts.fileTree.length && <div className="col-span-full text-center">No files recorded yet.</div>}
                </div>
              </section>
            </>
          ) : (
            <EmptyState
              icon={<Boxes className="h-4 w-4" />}
              title={loading ? "Loading run…" : "No run selected"}
              description="Launch a pipeline or select a previous run to inspect the full execution trace."
              action={
                <Button size="sm" onClick={() => launchRunDialog()}>
                  <Rocket className="h-3.5 w-3.5" />
                  Launch a run
                </Button>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PhaseColumn({
  phaseId,
  phase,
  run,
  agents,
  models,
  onInspect,
}: {
  phaseId: PhaseId;
  phase?: PhaseState;
  run: Run;
  agents: ReturnType<typeof useFactory.getState>["agents"];
  models: ReturnType<typeof useFactory.getState>["models"];
  onInspect: (id: PhaseId) => void;
}) {
  const meta = SDLC_PHASE_META[phaseId];
  const definition = PHASES.find((item) => item.id === phaseId)!;
  const agent = agents.find((item) => item.id === phase?.agentId);
  const model = models.find((item) => item.key === agent?.modelKey);
  const lastLogs = phase?.logs.slice(-3) ?? [];
  const status = phase?.status ?? "pending";
  return (
    <section className="flex w-[252px] shrink-0 flex-col rounded-xl border border-border/70 bg-card/50">
      <div className="border-b border-border/60 p-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.16em]" style={{ color: meta.accent }}>
            {meta.short} · 0{meta.index}
          </span>
          <StatusPill status={status} kind="phase" />
        </div>
        <div className="mt-1 text-xs font-medium">{definition.name}</div>
        <div className="mt-2 flex items-center gap-1.5">
          {agent ? (
            <>
              <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="sm" />
              <span className="truncate text-[10px]">{agent.name}</span>
              <ModelBadge model={model} modelKey={agent.modelKey} compact className="ml-auto max-w-[90px]" />
            </>
          ) : (
            <span className="font-mono text-[9px] text-muted-foreground">{definition.agentRole}</span>
          )}
        </div>
      </div>
      <div className="flex-1 space-y-2.5 p-3">
        <p className="min-h-[48px] text-[10px] leading-relaxed text-muted-foreground">{definition.description}</p>
        <div>
          <div className="mb-1 flex items-center justify-between font-mono text-[8px] text-muted-foreground">
            <span>progress</span>
            <span>{phase?.progress ?? 0}%</span>
          </div>
          <Progress
            value={phase?.progress ?? 0}
            className="h-1"
            indicatorClassName={status === "failed" ? "bg-factory-red" : status === "running" ? "bg-factory-amber" : "bg-factory-lime"}
          />
        </div>

        {!!phase?.artifacts.length && (
          <div className="flex flex-wrap gap-1">
            {phase.artifacts.slice(0, 3).map((artifact) => (
              <span key={artifact} className="max-w-full truncate rounded border border-border/60 bg-black/30 px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground">
                {artifact}
              </span>
            ))}
          </div>
        )}

        {!!phase?.healAttempts.length && (
          <div className="rounded border border-factory-amber/20 bg-factory-amber/5 px-2 py-1.5">
            <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-wider text-factory-amber">
              <Wrench className="h-2.5 w-2.5" />
              {phase.healAttempts.length} heal {phase.healAttempts.length === 1 ? "loop" : "loops"}
            </div>
            {phase.healAttempts.slice(-2).map((attempt) => (
              <div key={attempt.attempt} className="mt-0.5 truncate font-mono text-[8px] text-muted-foreground">
                #{attempt.attempt} {attempt.appliedFiles.length} files · {attempt.result}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1">
          {lastLogs.map((log) => (
            <div key={log.id} className="flex gap-1.5 text-[9px] leading-snug">
              <span
                className={cn(
                  "mt-1 h-1 w-1 shrink-0 rounded-full",
                  log.level === "error"
                    ? "bg-factory-red"
                    : log.level === "success"
                      ? "bg-factory-lime"
                      : log.level === "warn"
                        ? "bg-factory-amber"
                        : "bg-white/25",
                )}
              />
              <span className="line-clamp-2 text-muted-foreground">{log.message}</span>
            </div>
          ))}
          {!lastLogs.length && (
            <div className="flex items-center gap-1.5 py-2 text-[9px] text-muted-foreground/60">
              <Circle className="h-2 w-2" />
              waiting for upstream phase
            </div>
          )}
        </div>
      </div>
      <button
        onClick={() => onInspect(phaseId)}
        className="flex items-center justify-between border-t border-border/60 px-3 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground"
      >
        Inspect trace
        <ChevronRight className="h-3 w-3" />
      </button>
    </section>
  );
}

function AllLogs({ run }: { run: Run }) {
  const [level, setLevel] = useState<string>("all");
  const logs = useMemo(
    () =>
      run.phases
        .flatMap((phase) =>
          phase.logs.map((log) => ({ ...log, phase: phase.name, phaseId: phase.id })),
        )
        .sort((a, b) => a.at - b.at)
        .filter((log) => level === "all" || log.level === level),
    [run, level],
  );
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-factory-lime" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            factory.log
          </span>
          <Badge variant="outline">{logs.length}</Badge>
        </div>
        <div className="flex gap-1">
          {["all", "success", "error", "command", "agent"].map((value) => (
            <button
              key={value}
              onClick={() => setLevel(value)}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider",
                level === value ? "bg-factory-lime/10 text-factory-lime" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[520px] overflow-y-auto p-3 font-mono">
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2 border-b border-border/20 py-1.5 text-[10px] last:border-0">
            <span className="w-16 shrink-0 text-muted-foreground/50">
              {new Date(log.at).toLocaleTimeString([], { hour12: false })}
            </span>
            <span
              className={cn(
                "w-14 shrink-0 uppercase",
                log.level === "error"
                  ? "text-factory-red"
                  : log.level === "success"
                    ? "text-factory-lime"
                    : log.level === "warn"
                      ? "text-factory-amber"
                      : log.level === "command"
                        ? "text-factory-cyan"
                        : "text-muted-foreground/60",
              )}
            >
              {log.level}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground/80">{log.message}</span>
              {log.detail && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[9px] leading-relaxed text-muted-foreground/70">
                  {log.detail}
                </pre>
              )}
            </span>
          </div>
        ))}
        {!logs.length && <div className="py-12 text-center text-xs text-muted-foreground">No log lines match.</div>}
      </div>
    </div>
  );
}

function ArtifactRow({ label, path, exists }: { label: string; path: string; exists: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border/50 bg-black/20 px-2 py-1.5">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <FileCode2 className="h-3 w-3" />
        {label}
      </span>
      <span className={cn("max-w-[180px] truncate font-mono text-[9px]", exists ? "text-factory-lime" : "text-muted-foreground/50")}>
        {exists ? path : "not generated"}
      </span>
    </div>
  );
}
