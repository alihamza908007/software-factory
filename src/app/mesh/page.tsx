"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, BarChart3, CheckCircle2, Loader2, MessagesSquare, Pause, Radio, RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/data/store";
import type { Agent } from "@/lib/core/types";
import { timeAgo } from "@/lib/core/utils";
import { PageHeader, SectionLabel } from "@/components/shared/page-header";

import { Metric } from "@/components/shared/metric";
import { MeshEventCard } from "@/components/chat/AgentChatMatrix";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { AgentNodeCard } from "@/components/mesh/agent-node-card";
import { AnalyticsDrawer } from "@/components/mesh/analytics-drawer";
import { MemoryPanel } from "@/components/mesh/memory-panel";
import { NegotiationPanel } from "@/components/mesh/negotiation-panel";
import { WIRE_TYPES, eventMatchesFilter, type WireFilter } from "@/components/mesh/wire-filter";

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
  const [wireFilter, setWireFilter] = useState<WireFilter>("useful");
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
  const completedCycles = meshEvents.filter(
    (event) =>
      (event.type === "TASK_CONTRACT" && event.title === "Agent response delivered") ||
      event.type === "POST_FLIGHT_PASSED" ||
      event.type === "CANVAS_RUN_COMPLETED" ||
      event.type === "AUTOMATION_PASSED",
  ).length;
  const errorCycles = meshEvents.filter(
    (event) => event.severity === "error" || (event.requiresOverride && !overriddenEventIds.includes(event.id)),
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

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(220px,260px)_minmax(0,1fr)]">
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

        <aside className="min-w-0 space-y-3">
          <section className="panel p-3">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <span className="eyebrow flex items-center gap-1.5">
                <Activity className="h-3 w-3 text-factory-cyan" />
                Cycle status
              </span>
              <Badge variant={errorCycles ? "warning" : "success"}>
                {errorCycles ? `${errorCycles} errors` : "healthy"}
              </Badge>
            </div>
            <div className="grid grid-cols-3 gap-2 p-2">
              <div className="rounded-md border border-border/60 bg-secondary/50 p-2 text-center">
                <div className="font-mono text-lg font-semibold text-factory-amber">{activeAgents}</div>
                <div className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">In progress</div>
              </div>
              <div className="rounded-md border border-border/60 bg-secondary/50 p-2 text-center">
                <div className="font-mono text-lg font-semibold text-factory-lime">{completedCycles}</div>
                <div className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">Completed</div>
              </div>
              <div className="rounded-md border border-border/60 bg-secondary/50 p-2 text-center">
                <div className="font-mono text-lg font-semibold text-red-400">{errorCycles}</div>
                <div className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">Errors</div>
              </div>
            </div>
          </section>
          <section className="panel p-3">
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <span className="eyebrow flex items-center gap-1.5">
                <MessagesSquare className="h-3 w-3 text-factory-cyan" />
                Recent agent activity
              </span>
              <Link href="/chat" className="font-mono text-[9px] text-factory-cyan hover:underline">
                Open Chat Matrix →
              </Link>
            </div>
            <div className="space-y-1.5 p-2">
              {meshEvents
                .filter((event) => event.type === "HANDOFF" || event.type === "TASK_CONTRACT" || event.type === "AGENT_ENVELOPE")
                .slice(-4)
                .reverse()
                .map((event) => (
                  <div key={event.id} className="rounded-md border border-border/60 bg-secondary/50 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[10px] font-medium">{event.title}</span>
                      <span className="ml-auto font-mono text-[8px] text-muted-foreground">{timeAgo(event.at)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">
                      {event.message}
                    </p>
                  </div>
                ))}
              {!meshEvents.some((e) => e.type === "HANDOFF" || e.type === "TASK_CONTRACT" || e.type === "AGENT_ENVELOPE") && (
                <p className="px-2 py-6 text-center text-[10px] text-muted-foreground">
                  No agent activity yet. Start a conversation in the Chat Matrix.
                </p>
              )}
            </div>
          </section>
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
                  <SelectItem value="useful">Useful</SelectItem>
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