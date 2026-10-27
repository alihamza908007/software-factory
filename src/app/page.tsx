"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bot,
  Boxes,
  ChevronRight,
  Cloud,
  Cpu,
  GitBranch,
  Layers,
  MessagesSquare,
  Plus,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import { useFactory } from "@/lib/store";
import { cn, formatCost, formatDuration, formatMB, formatTokens, timeAgo, truncate } from "@/lib/utils";
import { SDLC_PHASE_META } from "@/lib/constants";
import { launchRunDialog } from "@/components/shared/run-launcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PageHeader, SectionLabel } from "@/components/shared/page-header";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ModelBadge } from "@/components/shared/model-badge";
import { Metric, Sparkline } from "@/components/shared/metric";
import { StatusPill } from "@/components/shared/status";
import { EmptyState } from "@/components/shared/empty-state";

export default function CommandCenterPage() {
  const { agents, runs, resources, health, metrics, models, projects } = useFactory();

  const activeRuns = runs.filter((run) => run.status === "running" || run.status === "queued");
  const primaryRun = activeRuns[0] ?? runs[0];
  const localModels = models.filter((model) => model.kind === "local");
  const cloudModels = models.filter((model) => model.kind === "cloud");
  const heals = runs.reduce(
    (sum, run) => sum + run.phases.reduce((count, phase) => count + phase.healAttempts.length, 0),
    0,
  );
  const passed = runs.filter((run) => run.status === "passed").length;
  const budget = resources?.budgetMB ?? 36864;
  const used = resources?.usedMB ?? 0;
  const pct = budget ? Math.min(100, (used / budget) * 100) : 0;
  const latestLogs = primaryRun?.phases
    .flatMap((phase) => phase.logs.map((log) => ({ ...log, phase: phase.name })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 7);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Live factory floor"
        title="Autonomous software, assembled locally."
        description="Define a brief. Five specialist agents turn it into a spec, an architecture, working code, a passing test suite and a CI-backed pull request — while the VRAM guard keeps your Mac responsive."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/chat">
                <MessagesSquare className="h-3.5 w-3.5" />
                Open chat
              </Link>
            </Button>
            <Button size="sm" onClick={() => launchRunDialog()}>
              <Plus className="h-3.5 w-3.5" />
              New run
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <section className="relative overflow-hidden rounded-xl border border-border/80 bg-gradient-to-br from-secondary via-card to-background p-5 md:p-6">
          <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-factory-lime/10 blur-3xl" />
          <div className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-factory-lime/50 to-transparent" />
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-factory-lime">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-factory-lime opacity-40" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-factory-lime" />
                </span>
                Factory {activeRuns.length ? "in motion" : "ready"}
              </div>
              <h3 className="max-w-xl text-2xl font-semibold leading-tight tracking-tight text-balance">
                {primaryRun
                  ? truncate(primaryRun.prompt, 110)
                  : "Your agent workforce is idle. Give it something worth building."}
              </h3>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                {primaryRun ? (
                  <>
                    <StatusPill status={primaryRun.status} />
                    <span className="font-mono text-[10px]">{primaryRun.projectName}</span>
                    <span className="font-mono text-[10px]">branch {primaryRun.git.branch ?? "—"}</span>
                    <span className="font-mono text-[10px]">{timeAgo(primaryRun.updatedAt)}</span>
                  </>
                ) : (
                  <span className="text-xs">
                    Start a run to watch requirements, architecture, implementation, testing and
                    deployment stream in real time.
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {primaryRun ? (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={`/pipeline?run=${primaryRun.id}`}>
                    Open pipeline
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => launchRunDialog()}>
                  Launch first run
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 border-t border-white/5 pt-4 sm:grid-cols-4">
            <Metric label="Active runs" value={activeRuns.length} sub={`${runs.length} total`} />
            <Metric label="Completed" value={passed} sub={`${heals} self-heals`} />
            <Metric label="Agents" value={agents.filter((agent) => agent.enabled).length} sub={`${agents.length} configured`} />
            <Metric
              label="Models"
              value={localModels.length + cloudModels.length}
              sub={`${localModels.length} local · ${cloudModels.length} cloud`}
            />
          </div>

          {primaryRun && (
            <div className="mt-5 border-t border-white/5 pt-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow">Phase telemetry</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {primaryRun.phases.filter((phase) => phase.status === "passed").length}/5 passed
                </span>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {primaryRun.phases.map((phase, index) => {
                  const meta = SDLC_PHASE_META[phase.id];
                  return (
                    <div key={phase.id} className="min-w-0">
                      <div className="mb-1.5 flex items-center gap-1">
                        <span
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded-full border font-mono text-[8px]",
                            phase.status === "passed"
                              ? "border-factory-lime/50 bg-factory-lime/15 text-factory-lime"
                              : phase.status === "running"
                                ? "border-factory-amber/50 bg-factory-amber/15 text-factory-amber"
                                : phase.status === "failed"
                                  ? "border-red-400/50 bg-red-400/10 text-red-300"
                                  : "border-border text-muted-foreground",
                          )}
                        >
                          {index + 1}
                        </span>
                        <span className="truncate font-mono text-[9px] text-muted-foreground">
                          {meta.short}
                        </span>
                      </div>
                      <Progress
                        value={phase.progress}
                        className="h-1"
                        indicatorClassName={
                          phase.status === "failed"
                            ? "bg-factory-red"
                            : phase.status === "running"
                              ? "bg-factory-amber"
                              : "bg-factory-lime"
                        }
                      />
                      <div className="mt-1 truncate text-[9px] text-muted-foreground/70">
                        {phase.status === "running" ? "working…" : phase.status}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="panel p-5">
          <SectionLabel
            action={
              <Badge variant={health?.ollama.online ? "success" : "destructive"}>
                {health?.ollama.online ? "Ollama online" : "Ollama offline"}
              </Badge>
            }
          >
            Unified memory guard
          </SectionLabel>
          <div className="flex items-end justify-between">
            <div>
              <div className="metric text-3xl">{formatMB(used)}</div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                of {formatMB(budget)} usable · {formatMB(resources?.availableMB ?? budget)} free
              </div>
            </div>
            <div className="text-right font-mono text-[10px] text-muted-foreground">
              <div>{resources?.maxConcurrentHeavy ?? 1} heavy max</div>
              <div>{resources?.allowConcurrentLight ? "light concurrency on" : "serial mode"}</div>
            </div>
          </div>
          <Progress
            value={pct}
            className="mt-4 h-2"
            indicatorClassName={pct > 85 ? "bg-factory-red" : pct > 60 ? "bg-factory-amber" : "bg-factory-lime"}
          />
          <div className="mt-4 space-y-2">
            {resources?.running.length ? (
              resources.running.map((reservation) => (
                <div
                  key={reservation.id}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-secondary/50 px-2.5 py-2"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded bg-factory-amber/10 text-factory-amber">
                    <Cpu className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium">
                      {reservation.agentName ?? reservation.label}
                    </div>
                    <div className="truncate font-mono text-[9px] text-muted-foreground">
                      {reservation.modelName} · {formatMB(reservation.vramMB)}
                    </div>
                  </div>
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-factory-lime" />
                </div>
              ))
            ) : (
              <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
                No local model is resident. The queue is clear.
              </div>
            )}
            {!!resources?.queued.length && (
              <div className="flex items-center justify-between rounded-md border border-factory-amber/20 bg-factory-amber/5 px-2.5 py-1.5 font-mono text-[10px] text-factory-amber">
                <span>{resources.queued.length} generation(s) queued</span>
                <span>priority {resources.queued[0]?.priority ?? "—"}</span>
              </div>
            )}
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-factory-lime" />
              Fallback: {models.find((model) => model.key.includes("deepseek"))?.name ?? "cloud"}
            </span>
            <Link href="/settings" className="flex items-center gap-0.5 hover:text-foreground">
              Tune <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <section>
          <SectionLabel
            action={
              <Link href="/agents" className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground">
                Manage workforce <ChevronRight className="h-3 w-3" />
              </Link>
            }
          >
            Agent workforce
          </SectionLabel>
          <div className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
            {agents.map((agent) => {
              const agentMetrics = metrics.filter((metric) => metric.agentId === agent.id).slice(0, 12);
              const latest = agentMetrics[0];
              const model = models.find((item) => item.key === agent.modelKey);
              return (
                <Link
                  key={agent.id}
                  href={`/agents?agent=${agent.id}`}
                  className="group panel p-3.5 transition-colors hover:border-white/20 hover:bg-card"
                >
                  <div className="flex items-start gap-2.5">
                    <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium">{agent.name}</span>
                        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5" />
                      </div>
                      <div className="truncate font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        {agent.role}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <ModelBadge model={model} modelKey={agent.modelKey} compact />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/50 pt-2.5 font-mono text-[9px]">
                    <div>
                      <div className="text-muted-foreground/60">TTFT</div>
                      <div className="text-foreground">{latest ? formatDuration(latest.ttftMs) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground/60">TOK/S</div>
                      <div className="text-foreground">{latest ? latest.tokensPerSec.toFixed(1) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground/60">CALLS</div>
                      <div className="text-foreground">{agentMetrics.length}</div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="panel flex min-h-[320px] flex-col p-4">
          <SectionLabel
            action={
              primaryRun ? (
                <Link
                  href={`/pipeline?run=${primaryRun.id}`}
                  className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                >
                  Full trace <ChevronRight className="h-3 w-3" />
                </Link>
              ) : null
            }
          >
            Live factory log
          </SectionLabel>
          <div className="mask-fade-y flex-1 space-y-2 overflow-hidden">
            {latestLogs?.length ? (
              latestLogs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span
                    className={cn(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      log.level === "error"
                        ? "bg-factory-red"
                        : log.level === "success"
                          ? "bg-factory-lime"
                          : log.level === "warn"
                            ? "bg-factory-amber"
                            : log.level === "command"
                              ? "bg-factory-cyan"
                              : "bg-muted-foreground",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-[11px] leading-snug text-foreground/85">{log.message}</div>
                    <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/60">
                      {log.phase} · {timeAgo(log.at)}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                icon={<Terminal className="h-4 w-4" />}
                title="No execution trace yet"
                description="Logs from the next run will stream here."
                className="border-0 bg-transparent py-10"
              />
            )}
          </div>
        </section>
      </div>

      <section>
        <SectionLabel
          action={
            <Link href="/pipeline" className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground">
              All runs <ChevronRight className="h-3 w-3" />
            </Link>
          }
        >
          Recent runs
        </SectionLabel>
        {runs.length ? (
          <div className="panel overflow-hidden">
            <div className="hidden grid-cols-[1.5fr_120px_140px_120px_100px] gap-4 border-b border-border/60 px-4 py-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground md:grid">
              <span>Brief</span>
              <span>Project</span>
              <span>Status</span>
              <span>Branch</span>
              <span className="text-right">Updated</span>
            </div>
            {runs.slice(0, 6).map((run) => (
              <Link
                key={run.id}
                href={`/pipeline?run=${run.id}`}
                className="grid grid-cols-1 gap-2 border-b border-border/40 px-4 py-3 text-xs transition-colors last:border-0 hover:bg-secondary/50 md:grid-cols-[1.5fr_120px_140px_120px_100px] md:items-center md:gap-4"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      run.status === "running"
                        ? "animate-pulse bg-factory-lime"
                        : run.status === "passed"
                          ? "bg-factory-lime/70"
                          : run.status === "failed"
                            ? "bg-factory-red"
                            : "bg-muted-foreground",
                    )}
                  />
                  <span className="truncate text-foreground/90">{truncate(run.prompt, 90)}</span>
                </div>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{run.projectName}</span>
                <div>
                  <StatusPill status={run.status} />
                </div>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{run.git.branch ?? "—"}</span>
                <span className="font-mono text-[10px] text-muted-foreground md:text-right">{timeAgo(run.updatedAt)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Layers className="h-4 w-4" />}
            title="No factory runs yet"
            description="Launch a run to generate your first spec-to-PR pipeline."
            action={
              <Button size="sm" onClick={() => launchRunDialog()}>
                <Sparkles className="h-3.5 w-3.5" />
                Launch a run
              </Button>
            }
          />
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <QuickCard
          icon={<Boxes className="h-4 w-4" />}
          label="Workspaces"
          value={String(projects.length)}
          href="/projects"
          hint="Scaffolded project folders"
        />
        <QuickCard
          icon={<GitBranch className="h-4 w-4" />}
          label="Feature branches"
          value={String(new Set(runs.map((run) => run.git.branch).filter(Boolean)).size)}
          href="/pipeline"
          hint="Semantic commits per phase"
        />
        <QuickCard
          icon={<Wrench className="h-4 w-4" />}
          label="Self-heal loops"
          value={String(heals)}
          href="/pipeline"
          hint="Failures piped back to dev"
        />
        <QuickCard
          icon={<Zap className="h-4 w-4" />}
          label="Avg tok/s"
          value={
            metrics.length
              ? (
                  metrics.slice(0, 50).reduce((sum, metric) => sum + metric.tokensPerSec, 0) /
                  Math.min(50, metrics.length)
                ).toFixed(1)
              : "—"
          }
          href="/agents"
          hint="Across recent generations"
        />
      </div>
    </div>
  );
}

function QuickCard({
  icon,
  label,
  value,
  href,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
  hint: string;
}) {
  return (
    <Link href={href} className="panel group flex items-center justify-between p-4 transition-colors hover:border-white/20">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-secondary/50 text-factory-cyan">
          {icon}
        </span>
        <div>
          <div className="eyebrow">{label}</div>
          <div className="font-mono text-xl font-medium">{value}</div>
          <div className="text-[10px] text-muted-foreground">{hint}</div>
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
