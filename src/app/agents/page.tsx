"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Cloud,
  Cpu,
  DollarSign,
  Gauge,
  Loader2,
  MemoryStick,
  Pencil,
  Plus,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type { Agent, AgentMetric } from "@/lib/types";
import { AGENT_PALETTE } from "@/lib/constants";
import { cn, formatCost, formatDuration, formatMB, formatTokens, timeAgo } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/shared/page-header";
import { AgentAvatar, AgentIcon } from "@/components/shared/agent-avatar";
import { ModelBadge } from "@/components/shared/model-badge";
import { Metric, Sparkline } from "@/components/shared/metric";
import { EmptyState } from "@/components/shared/empty-state";
import { ModelSelect } from "@/components/agents/model-select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Draft = Omit<Agent, "id" | "createdAt" | "updatedAt"> & { id?: string };

const ICON_OPTIONS = ["Bot", "ClipboardList", "Network", "Code2", "ShieldCheck", "Rocket", "Sparkles", "UserCog"];

function emptyDraft(models: ReturnType<typeof useFactory.getState>["models"]): Draft {
  const preferred =
    models.find((model) => model.kind === "local" && model.heavy) ??
    models.find((model) => model.kind === "local") ??
    models[0];
  return {
    name: "",
    handle: "",
    role: "Specialist",
    description: "",
    systemPrompt: "",
    modelKey: preferred?.key ?? "",
    fallbackModelKey: models.find((model) => model.kind === "cloud")?.key ?? "",
    temperature: 0.3,
    maxTokens: 4096,
    allowConcurrency: true,
    enabled: true,
    color: AGENT_PALETTE[Math.floor(Math.random() * AGENT_PALETTE.length)],
    icon: "Bot",
  };
}

export default function AgentsPage() {
  const {
    agents,
    metrics,
    models,
    updateAgentLocal,
    fetchAgents,
    patchModel,
    settings,
  } = useFactory();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [perfAgent, setPerfAgent] = useState<Agent | null>(null);
  const [perfMetrics, setPerfMetrics] = useState<AgentMetric[]>([]);
  const [deleting, setDeleting] = useState<Agent | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("agent");
    if (id && agents.length) {
      const agent = agents.find((item) => item.id === id);
      if (agent) setPerfAgent(agent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length]);

  useEffect(() => {
    if (!perfAgent) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/agents/${perfAgent.id}/metrics?limit=120`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { metrics: AgentMetric[] };
        if (!cancelled) setPerfMetrics(data.metrics);
      } catch {
        // polling best effort
      }
    };
    void load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [perfAgent]);

  const filtered = useMemo(
    () =>
      agents.filter((agent) =>
        `${agent.name} ${agent.role} ${agent.handle} ${agent.modelKey}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [agents, query],
  );

  const localAgents = agents.filter((agent) => agent.modelKey.startsWith("ollama/")).length;
  const avgTtft = metrics.length
    ? metrics.slice(0, 80).reduce((sum, metric) => sum + metric.ttftMs, 0) /
      Math.min(80, metrics.length)
    : 0;
  const avgTok = metrics.length
    ? metrics.slice(0, 80).reduce((sum, metric) => sum + metric.tokensPerSec, 0) /
      Math.min(80, metrics.length)
    : 0;
  const totalCost = metrics.reduce((sum, metric) => sum + metric.costUsd, 0);

  async function saveDraft() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.role.trim() || !editing.modelKey) {
      toast.error("Name, role and model are required.");
      return;
    }
    setSaving(true);
    try {
      const isNew = !editing.id;
      const res = await fetch(isNew ? "/api/agents" : `/api/agents/${editing.id}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editing),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save agent.");
      updateAgentLocal(data.agent);
      await fetchAgents();
      setEditing(null);
      toast.success(isNew ? "Agent hired" : "Agent updated", {
        description: `${data.agent.name} · ${data.agent.modelKey}`,
      });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleModelSwitch(agent: Agent, modelKey: string) {
    if (!modelKey || modelKey === agent.modelKey) return;
    setSwitching(agent.id);
    const updated = await patchModel(agent.id, modelKey);
    setSwitching(null);
    if (updated) {
      toast.success("Model routing switched", {
        description: `${agent.name} → ${modelKey.split("/").slice(1).join("/")}`,
      });
    } else {
      toast.error("Could not switch model");
    }
  }

  async function toggleAgent(agent: Agent, enabled: boolean) {
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      updateAgentLocal(data.agent);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function deleteAgent() {
    if (!deleting) return;
    try {
      const res = await fetch(`/api/agents/${deleting.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      await fetchAgents();
      toast.success(`${deleting.name} removed from the workforce.`);
      setDeleting(null);
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Workforce configuration"
        title="Agent Manager"
        description="Hire specialists, give them a role and system prompt, and route each one to a local or cloud model. Model changes take effect on the very next generation."
        actions={
          <Button size="sm" onClick={() => setEditing(emptyDraft(models))}>
            <Plus className="h-3.5 w-3.5" />
            New agent
          </Button>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="panel p-4">
          <Metric label="Active agents" value={agents.filter((agent) => agent.enabled).length} sub={`${agents.length} total hired`} />
        </div>
        <div className="panel p-4">
          <Metric label="Local routing" value={localAgents} sub={`${agents.length - localAgents} on cloud`} accent="#f5b544" />
        </div>
        <div className="panel p-4">
          <Metric label="Avg TTFT" value={avgTtft ? formatDuration(avgTtft) : "—"} sub="recent 80 calls" accent="#6fe7dd" />
        </div>
        <div className="panel p-4">
          <Metric label="Avg throughput" value={avgTok ? `${avgTok.toFixed(1)} tok/s` : "—"} sub={`${formatCost(totalCost)} cloud spend`} accent="#c8f169" />
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, role or model…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><Cpu className="h-3 w-3 text-factory-amber" /> Ollama</span>
          <span className="flex items-center gap-1"><Cloud className="h-3 w-3 text-factory-cyan" /> OpenCode</span>
          <span className="flex items-center gap-1"><SlidersHorizontal className="h-3 w-3" /> live routing</span>
        </div>
      </div>

      {filtered.length ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((agent) => {
            const recent = metrics.filter((metric) => metric.agentId === agent.id).slice(0, 14);
            const latest = recent[0];
            const model = models.find((item) => item.key === agent.modelKey);
            return (
              <section
                key={agent.id}
                className={cn(
                  "panel relative overflow-hidden p-4 transition-colors",
                  agent.enabled ? "hover:border-white/15" : "opacity-60",
                )}
              >
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-80"
                  style={{ background: `linear-gradient(90deg, transparent, ${agent.color}, transparent)` }}
                />
                <div className="flex items-start gap-3">
                  <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">{agent.name}</h3>
                      <span className="font-mono text-[10px] text-muted-foreground">@{agent.handle}</span>
                      {!agent.enabled && <Badge variant="outline">paused</Badge>}
                    </div>
                    <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                      {agent.role}
                    </div>
                  </div>
                  <Switch
                    checked={agent.enabled}
                    onCheckedChange={(enabled) => void toggleAgent(agent, enabled)}
                    aria-label={`Toggle ${agent.name}`}
                  />
                </div>

                <p className="mt-3 line-clamp-2 min-h-[32px] text-[11px] leading-relaxed text-muted-foreground">
                  {agent.description}
                </p>

                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="eyebrow">Primary model</span>
                    {switching === agent.id && <Loader2 className="h-3 w-3 animate-spin text-factory-lime" />}
                  </div>
                  <ModelSelect
                    value={agent.modelKey}
                    onChange={(value) => void handleModelSwitch(agent, value)}
                    models={models}
                    className="h-8 bg-black/20"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <ModelBadge model={model} modelKey={agent.modelKey} compact />
                    <span className="font-mono text-[9px] text-muted-foreground">
                      {model?.kind === "local"
                        ? `${formatMB(model.vramEstimateMB)} VRAM`
                        : model?.zeroCost
                          ? "free tier"
                          : formatCost(model?.costInputPerMTok)}
                    </span>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-border/60 bg-black/20 p-2.5">
                  <div>
                    <div className="eyebrow">TTFT</div>
                    <div className="font-mono text-xs">{latest ? formatDuration(latest.ttftMs) : "—"}</div>
                  </div>
                  <div>
                    <div className="eyebrow">Tok/s</div>
                    <div className="font-mono text-xs">{latest ? latest.tokensPerSec.toFixed(1) : "—"}</div>
                  </div>
                  <div>
                    <div className="eyebrow">Calls</div>
                    <div className="font-mono text-xs">{recent.length}</div>
                  </div>
                </div>
                <div className="mt-1.5 h-6">
                  <Sparkline values={recent.slice().reverse().map((metric) => metric.tokensPerSec)} color={agent.color} className="h-6" />
                </div>

                <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-3">
                  <Button variant="secondary" size="sm" className="flex-1" onClick={() => setPerfAgent(agent)}>
                    <Gauge className="h-3.5 w-3.5" />
                    Performance
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing({ ...agent })} aria-label={`Edit ${agent.name}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-red-300"
                    onClick={() => setDeleting(agent)}
                    aria-label={`Delete ${agent.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Bot className="h-4 w-4" />}
          title="No agents match"
          description="Try a different search or hire a new specialist."
          action={
            <Button size="sm" onClick={() => setEditing(emptyDraft(models))}>
              <Plus className="h-3.5 w-3.5" />
              New agent
            </Button>
          }
        />
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-factory-lime">
              {editing?.id ? "Edit specialist" : "Hire specialist"}
            </div>
            <DialogTitle>{editing?.id ? `Configure ${editing.name}` : "New agent"}</DialogTitle>
            <DialogDescription>
              Identity, prompt and model routing. Local models are automatically serialized by the
              VRAM guard; cloud models bypass the local queue.
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="grid gap-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Name</Label>
                  <Input
                    value={editing.name}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        name: event.target.value,
                        handle: editing.handle || event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
                      })
                    }
                    placeholder="e.g. Sable"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Handle</Label>
                  <Input
                    value={editing.handle}
                    onChange={(event) => setEditing({ ...editing, handle: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })}
                    placeholder="security"
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Role</Label>
                  <Input
                    value={editing.role}
                    onChange={(event) => setEditing({ ...editing, role: event.target.value })}
                    placeholder="Security Reviewer"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Icon</Label>
                  <Select value={editing.icon} onValueChange={(value) => setEditing({ ...editing, icon: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ICON_OPTIONS.map((icon) => (
                        <SelectItem key={icon} value={icon}>
                          <span className="flex items-center gap-2">
                            <AgentIcon name={icon} className="h-3.5 w-3.5" />
                            {icon}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label>Short description</Label>
                  <Input
                    value={editing.description}
                    onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                    placeholder="What this specialist owns"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Primary model</Label>
                  <ModelSelect
                    value={editing.modelKey}
                    onChange={(modelKey) => setEditing({ ...editing, modelKey })}
                    models={models}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Fallback model</Label>
                  <ModelSelect
                    value={editing.fallbackModelKey ?? ""}
                    onChange={(fallbackModelKey) => setEditing({ ...editing, fallbackModelKey })}
                    models={models}
                    allowNone
                    noneLabel="Use global fallback"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label>Temperature</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="2"
                      value={editing.temperature}
                      onChange={(event) => setEditing({ ...editing, temperature: Number(event.target.value) })}
                      className="font-mono"
                    />
                    <span className="font-mono text-[10px] text-muted-foreground">0–2</span>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label>Max output tokens</Label>
                  <Input
                    type="number"
                    min="256"
                    max="32768"
                    step="256"
                    value={editing.maxTokens}
                    onChange={(event) => setEditing({ ...editing, maxTokens: Number(event.target.value) })}
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Accent</Label>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {AGENT_PALETTE.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setEditing({ ...editing, color })}
                        className={cn(
                          "h-5 w-5 rounded-full border-2 transition-transform",
                          editing.color === color ? "scale-110 border-white" : "border-transparent opacity-70 hover:opacity-100",
                        )}
                        style={{ backgroundColor: color }}
                        aria-label={`Choose ${color}`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/70 bg-black/20 px-3 py-2.5">
                <div>
                  <div className="text-xs font-medium">Light-model concurrency</div>
                  <div className="text-[10px] text-muted-foreground">
                    Allow this agent to share VRAM with a light local model when policy permits.
                  </div>
                </div>
                <Switch
                  checked={editing.allowConcurrency}
                  onCheckedChange={(allowConcurrency) => setEditing({ ...editing, allowConcurrency })}
                />
              </div>

              <div className="grid gap-1.5">
                <Label>System prompt</Label>
                <Textarea
                  value={editing.systemPrompt}
                  onChange={(event) => setEditing({ ...editing, systemPrompt: event.target.value })}
                  rows={7}
                  placeholder="You are… You own… You always… You never…"
                  className="resize-y font-mono text-[11px] leading-relaxed"
                />
                <p className="text-[10px] text-muted-foreground">
                  This prompt is prepended to every generation. Keep it role-specific and explicit about output contracts.
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={saveDraft} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {editing?.id ? "Save changes" : "Hire agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PerformanceDialog agent={perfAgent} onClose={() => setPerfAgent(null)} metrics={perfMetrics} />

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {deleting?.name}?</DialogTitle>
            <DialogDescription>
              The agent definition is deleted. Historical metrics and run artifacts are preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={deleteAgent}>
              <Trash2 className="h-4 w-4" />
              Remove agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PerformanceDialog({
  agent,
  onClose,
  metrics,
}: {
  agent: Agent | null;
  onClose: () => void;
  metrics: AgentMetric[];
}) {
  const { models } = useFactory();
  const model = agent ? models.find((item) => item.key === agent.modelKey) : undefined;
  const avg = (key: "ttftMs" | "totalMs" | "tokensPerSec" | "costUsd") =>
    metrics.length ? metrics.reduce((sum, metric) => sum + metric[key], 0) / metrics.length : 0;
  const maxTok = Math.max(...metrics.map((metric) => metric.tokensPerSec), 1);
  return (
    <Dialog open={Boolean(agent)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-factory-cyan">
            <Activity className="h-3.5 w-3.5" />
            Performance dashboard
          </div>
          <DialogTitle className="flex items-center gap-2">
            {agent && <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="sm" />}
            {agent?.name} <span className="font-mono text-xs font-normal text-muted-foreground">@{agent?.handle}</span>
          </DialogTitle>
          <DialogDescription>
            Live telemetry from persisted generations. TTFT is measured from request dispatch to the first streamed token.
          </DialogDescription>
        </DialogHeader>

        {agent && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <ModelBadge model={model} modelKey={agent.modelKey} />
              <Badge variant="outline">{agent.role}</Badge>
              <Badge variant={agent.enabled ? "success" : "outline"}>{agent.enabled ? "active" : "paused"}</Badge>
              {model?.heavy && <Badge variant="warning">heavy · serialized</Badge>}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="panel-inset p-3">
                <Metric label="Avg TTFT" value={metrics.length ? formatDuration(avg("ttftMs")) : "—"} accent="#6fe7dd" />
              </div>
              <div className="panel-inset p-3">
                <Metric label="Avg total" value={metrics.length ? formatDuration(avg("totalMs")) : "—"} />
              </div>
              <div className="panel-inset p-3">
                <Metric label="Avg tok/s" value={metrics.length ? avg("tokensPerSec").toFixed(1) : "—"} accent="#c8f169" />
              </div>
              <div className="panel-inset p-3">
                <Metric label="Cost" value={formatCost(avg("costUsd") * metrics.length)} accent="#f5b544" />
              </div>
              <div className="panel-inset p-3">
                <Metric label="VRAM" value={agent.modelKey.startsWith("ollama/") ? formatMB(model?.vramEstimateMB) : "0 MB"} />
              </div>
              <div className="panel-inset p-3">
                <Metric label="Calls" value={metrics.length} sub={`${metrics.filter((metric) => metric.fellBack).length} fallbacks`} />
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="panel-inset p-3">
                <SectionLabel>Throughput · recent calls</SectionLabel>
                <div className="flex h-28 items-end gap-1">
                  {metrics.slice(0, 32).reverse().map((metric) => (
                    <div key={metric.id} className="group relative flex-1">
                      <div
                        className="w-full rounded-sm bg-factory-lime/60 transition-colors group-hover:bg-factory-lime"
                        style={{ height: `${Math.max(3, (metric.tokensPerSec / maxTok) * 100)}%` }}
                      />
                      <div className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 font-mono text-[9px] group-hover:block">
                        {metric.tokensPerSec.toFixed(1)} tok/s
                      </div>
                    </div>
                  ))}
                  {!metrics.length && <div className="m-auto text-xs text-muted-foreground">No generations recorded yet.</div>}
                </div>
              </div>
              <div className="panel-inset p-3">
                <SectionLabel>Latency profile</SectionLabel>
                <div className="space-y-2">
                  {[
                    { label: "Time to first token", value: avg("ttftMs"), color: "#6fe7dd", max: Math.max(...metrics.map((metric) => metric.ttftMs), 1) },
                    { label: "Total completion", value: avg("totalMs"), color: "#f5b544", max: Math.max(...metrics.map((metric) => metric.totalMs), 1) },
                    { label: "Queue wait", value: metrics.length ? metrics.reduce((sum, metric) => sum + metric.queuedMs, 0) / metrics.length : 0, color: "#ff8fab", max: Math.max(...metrics.map((metric) => metric.queuedMs), 1) },
                  ].map((row) => (
                    <div key={row.label}>
                      <div className="mb-1 flex items-center justify-between font-mono text-[9px] text-muted-foreground">
                        <span>{row.label}</span>
                        <span>{formatDuration(row.value)}</span>
                      </div>
                      <Progress value={(row.value / row.max) * 100} className="h-1" indicatorClassName="" />
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[9px] text-muted-foreground">
                  <span>Input tokens: {formatTokens(metrics.reduce((sum, metric) => sum + metric.inputTokens, 0))}</span>
                  <span>Output tokens: {formatTokens(metrics.reduce((sum, metric) => sum + metric.outputTokens, 0))}</span>
                </div>
              </div>
            </div>

            <div className="panel-inset overflow-hidden">
              <div className="grid grid-cols-[1fr_80px_80px_70px_80px_80px] gap-2 border-b border-border/60 px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                <span>Model / time</span>
                <span>TTFT</span>
                <span>Total</span>
                <span>Tok/s</span>
                <span>Tokens</span>
                <span>Cost</span>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {metrics.slice(0, 40).map((metric) => (
                  <div
                    key={metric.id}
                    className="grid grid-cols-[1fr_80px_80px_70px_80px_80px] items-center gap-2 border-b border-border/30 px-3 py-2 font-mono text-[10px] last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-foreground/90">{metric.modelKey.split("/").slice(1).join("/")}</div>
                      <div className="text-[9px] text-muted-foreground">
                        {timeAgo(metric.createdAt)} {metric.fellBack ? "· fallback" : ""}
                      </div>
                    </div>
                    <span>{formatDuration(metric.ttftMs)}</span>
                    <span>{formatDuration(metric.totalMs)}</span>
                    <span className="text-factory-lime">{metric.tokensPerSec.toFixed(1)}</span>
                    <span className="text-muted-foreground">{formatTokens(metric.outputTokens)}</span>
                    <span>{formatCost(metric.costUsd)}</span>
                  </div>
                ))}
                {!metrics.length && (
                  <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                    Run a chat or pipeline task with {agent.name} to populate the dashboard.
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-black/20 px-3 py-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><Timer className="h-3 w-3" /> Streaming latency</span>
              <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-factory-lime" /> Local tok/s</span>
              <span className="flex items-center gap-1"><DollarSign className="h-3 w-3 text-factory-amber" /> Cost estimate</span>
              <span className="flex items-center gap-1"><MemoryStick className="h-3 w-3 text-factory-cyan" /> Unified memory</span>
              <span className="ml-auto flex items-center gap-1"><Sparkles className="h-3 w-3" /> settings.defaultAgentId</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
