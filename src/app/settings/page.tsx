"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Cpu,
  Database,
  FolderOpen,
  Github,
  HardDrive,
  KeyRound,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type { FactorySettings } from "@/lib/types";
import { cn, formatMB } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/shared/page-header";
import { Metric } from "@/components/shared/metric";
import { ModelSelect } from "@/components/agents/model-select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

type SettingsState = FactorySettings & {
  hasOpencodePassword?: boolean;
  hasGithubToken?: boolean;
};

export default function SettingsPage() {
  const {
    settings,
    models,
    agents,
    health,
    resources,
    resolvedOpencodeUrl,
    fetchSettings,
    fetchModels,
    fetchHealth,
    fetchResources,
  } = useFactory();
  const [draft, setDraft] = useState<SettingsState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [opencodePassword, setOpencodePassword] = useState("");
  const [githubToken, setGithubToken] = useState("");

  useEffect(() => {
    if (settings && !draft) setDraft(settings);
  }, [settings, draft]);

  useEffect(() => {
    if (!draft && settings) setDraft(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  function set<K extends keyof SettingsState>(key: K, value: SettingsState[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        ollamaUrl: draft.ollamaUrl,
        opencodeUrl: draft.opencodeUrl,
        vramBudgetMB: draft.vramBudgetMB,
        reserveMB: draft.reserveMB,
        maxConcurrentHeavy: draft.maxConcurrentHeavy,
        allowConcurrentLight: draft.allowConcurrentLight,
        allowCloudFallback: draft.allowCloudFallback,
        vramQueueTimeoutMs: draft.vramQueueTimeoutMs,
        fallbackModelKey: draft.fallbackModelKey,
        maxHealAttempts: draft.maxHealAttempts,
        commandTimeoutMs: draft.commandTimeoutMs,
        allowExecution: draft.allowExecution,
        autoCommit: draft.autoCommit,
        gitAuthorName: draft.gitAuthorName,
        gitAuthorEmail: draft.gitAuthorEmail,
        githubOwner: draft.githubOwner,
        githubRepo: draft.githubRepo,
        githubBaseBranch: draft.githubBaseBranch,
        githubCreateRepo: draft.githubCreateRepo,
        defaultAgentId: draft.defaultAgentId,
        autoHandoff: draft.autoHandoff,
        maxHandoffDepth: draft.maxHandoffDepth,
      };
      if (opencodePassword.trim()) payload.opencodePassword = opencodePassword.trim();
      if (githubToken.trim()) payload.githubToken = githubToken.trim();
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save settings.");
      setDraft({ ...data.settings, hasOpencodePassword: data.settings.hasOpencodePassword ?? Boolean(draft.hasOpencodePassword || opencodePassword), hasGithubToken: data.settings.hasGithubToken ?? Boolean(draft.hasGithubToken || githubToken) });
      setOpencodePassword("");
      setGithubToken("");
      await Promise.all([fetchSettings(), fetchModels(true), fetchHealth(), fetchResources()]);
      toast.success("Settings saved", { description: "The queue manager and model catalog are refreshed." });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearSecret(field: "opencode" | "github") {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          field === "opencode" ? { clearOpencodePassword: true } : { clearGithubToken: true },
        ),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await fetchSettings();
      toast.success(field === "opencode" ? "OpenCode password cleared." : "GitHub token cleared.");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function testConnections() {
    setTesting(true);
    try {
      await fetchHealth();
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = await res.json();
      toast[data.ollama.online ? "success" : "error"]("Provider probe complete", {
        description: `Ollama ${data.ollama.online ? "online" : "offline"} · OpenCode ${data.opencode.online ? "online" : "offline"} · ${data.models.local} local / ${data.models.cloud} cloud models`,
      });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels() {
    setRefreshing(true);
    try {
      await fetchModels(true);
      toast.success("Model catalog refreshed.");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function resetQueue() {
    try {
      const res = await fetch("/api/resources", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not reset queue.");
      await fetchResources();
      toast.success("Queue reservations cleared.");
    } catch (error) {
      toast.error(String(error));
    }
  }

  if (!draft) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading factory settings…
      </div>
    );
  }

  const budget = Math.max(1024, draft.vramBudgetMB - draft.reserveMB);
  const used = resources?.usedMB ?? 0;
  const memoryTotal = health?.hardware.totalMemoryMB ?? 49152;

  return (
    <div>
      <PageHeader
        eyebrow="Guardrails & providers"
        title="Settings"
        description="Tune the local model queue, provider endpoints, execution sandbox, git identity and GitHub integration. Secrets are stored only in .data/factory.json on this machine."
        actions={
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save settings
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <section className="panel p-4">
            <SectionLabel action={<Badge variant="success"><ShieldCheck className="h-2.5 w-2.5" /> hard guard</Badge>}>
              Resource & VRAM guardrails
            </SectionLabel>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Total unified memory budget (MB)</Label>
                <Input
                  type="number"
                  step="512"
                  min="8192"
                  max="49152"
                  value={draft.vramBudgetMB}
                  onChange={(event) => set("vramBudgetMB", Number(event.target.value))}
                  className="font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  Model weights + KV cache are measured against this ceiling.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label>Reserved for macOS (MB)</Label>
                <Input
                  type="number"
                  step="512"
                  min="2048"
                  max="24576"
                  value={draft.reserveMB}
                  onChange={(event) => set("reserveMB", Number(event.target.value))}
                  className="font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  Usable model budget: <span className="font-mono text-factory-lime">{formatMB(budget)}</span>
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label>Max concurrent heavy models</Label>
                <Input
                  type="number"
                  min="1"
                  max="4"
                  value={draft.maxConcurrentHeavy}
                  onChange={(event) => set("maxConcurrentHeavy", Number(event.target.value))}
                  className="font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  1 is the safe default for a single 27B model on 48 GB. Raising this is an explicit concurrency override.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label>Queue timeout before cloud fallback (ms)</Label>
                <Input
                  type="number"
                  step="5000"
                  min="5000"
                  max="600000"
                  value={draft.vramQueueTimeoutMs}
                  onChange={(event) => set("vramQueueTimeoutMs", Number(event.target.value))}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              <ToggleRow
                title="Allow light-model concurrency"
                description="A light local model may share memory with a resident heavy model when the budget permits."
                checked={draft.allowConcurrentLight}
                onChange={(value) => set("allowConcurrentLight", value)}
              />
              <ToggleRow
                title="Allow cloud fallback"
                description="When local VRAM is saturated or a local generation fails, route to the configured cloud model."
                checked={draft.allowCloudFallback}
                onChange={(value) => set("allowCloudFallback", value)}
              />
            </div>

            <div className="mt-4 grid gap-1.5">
              <Label>Global fallback model</Label>
              <ModelSelect
                value={draft.fallbackModelKey}
                onChange={(value) => set("fallbackModelKey", value)}
                models={models}
              />
            </div>
          </section>

          <section className="panel p-4">
            <SectionLabel action={
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={testConnections} disabled={testing}>
                  {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Network className="h-3 w-3" />}
                  Test
                </Button>
                <Button variant="outline" size="sm" onClick={refreshModels} disabled={refreshing}>
                  {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Refresh models
                </Button>
              </div>
            }>
              Provider connections
            </SectionLabel>

            <div className="grid gap-4">
              <div className="rounded-lg border border-border/60 bg-black/20 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs font-medium"><Cpu className="h-3.5 w-3.5 text-factory-amber" /> Ollama</span>
                  <Badge variant={health?.ollama.online ? "success" : "destructive"}>
                    {health?.ollama.online ? `online · v${health.ollama.version ?? "?"}` : "offline"}
                  </Badge>
                </div>
                <div className="grid gap-1.5">
                  <Label>Base URL</Label>
                  <Input
                    value={draft.ollamaUrl}
                    onChange={(event) => set("ollamaUrl", event.target.value)}
                    className="font-mono text-xs"
                    placeholder="http://127.0.0.1:11434"
                  />
                </div>
                <p className="mt-2 font-mono text-[9px] text-muted-foreground">
                  Discovery: /api/tags · streaming: /api/chat · resident models: /api/ps
                </p>
              </div>

              <div className="rounded-lg border border-border/60 bg-black/20 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs font-medium"><Cloud className="h-3.5 w-3.5 text-factory-cyan" /> OpenCode cloud</span>
                  <Badge variant={health?.opencode.online ? "success" : "destructive"}>
                    {health?.opencode.online ? `online · v${health.opencode.version ?? "?"}` : "offline"}
                  </Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>Server URL (blank = auto-discover)</Label>
                    <Input
                      value={draft.opencodeUrl}
                      onChange={(event) => set("opencodeUrl", event.target.value)}
                      className="font-mono text-xs"
                      placeholder={resolvedOpencodeUrl || "http://127.0.0.1:49374"}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Service password</Label>
                    <div className="flex gap-1.5">
                      <Input
                        type="password"
                        value={opencodePassword}
                        onChange={(event) => setOpencodePassword(event.target.value)}
                        className="font-mono text-xs"
                        placeholder={draft.hasOpencodePassword ? "•••••••• configured" : "auto-detected from ~/.config"}
                      />
                      {draft.hasOpencodePassword && (
                        <Button variant="ghost" size="icon" onClick={() => void clearSecret("opencode")} title="Clear stored password">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                <p className="mt-2 font-mono text-[9px] text-muted-foreground">
                  Cloud agents use stateless OpenCode sessions. Free-tier models are routed through the local OpenCode service.
                </p>
              </div>
            </div>
          </section>

          <section className="panel p-4">
            <SectionLabel>Execution, self-healing & git</SectionLabel>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Max self-heal attempts per run</Label>
                <Input
                  type="number"
                  min="0"
                  max="8"
                  value={draft.maxHealAttempts}
                  onChange={(event) => set("maxHealAttempts", Number(event.target.value))}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Command timeout (ms)</Label>
                <Input
                  type="number"
                  step="10000"
                  min="10000"
                  max="900000"
                  value={draft.commandTimeoutMs}
                  onChange={(event) => set("commandTimeoutMs", Number(event.target.value))}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Git author name</Label>
                <Input value={draft.gitAuthorName} onChange={(event) => set("gitAuthorName", event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Git author email</Label>
                <Input value={draft.gitAuthorEmail} onChange={(event) => set("gitAuthorEmail", event.target.value)} className="font-mono text-xs" />
              </div>
            </div>
            <div className="mt-4 grid gap-2">
              <ToggleRow
                title="Allow local command execution"
                description="The testing phase runs allowlisted commands (node, npm, python3, pytest, git) inside the workspace with a sanitized environment and timeout."
                checked={draft.allowExecution}
                onChange={(value) => set("allowExecution", value)}
              />
              <ToggleRow
                title="Automatic semantic commits"
                description="Commit each phase (spec, architecture, implementation, tests, CI) on the feature branch."
                checked={draft.autoCommit}
                onChange={(value) => set("autoCommit", value)}
              />
            </div>
            {!draft.allowExecution && (
              <div className="mt-3 flex items-start gap-2 rounded border border-factory-amber/20 bg-factory-amber/5 p-2.5 text-[10px] text-factory-amber">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Execution is disabled. Testing will not run and self-healing cannot converge. This is a static-generation mode.
              </div>
            )}
          </section>

          <section className="panel p-4">
            <SectionLabel action={<Badge variant={draft.hasGithubToken ? "success" : "outline"}>{draft.hasGithubToken ? "token configured" : "local only"}</Badge>}>
              GitHub & pull requests
            </SectionLabel>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Owner / organisation</Label>
                <Input value={draft.githubOwner} onChange={(event) => set("githubOwner", event.target.value)} placeholder="octocat" />
              </div>
              <div className="grid gap-1.5">
                <Label>Repository</Label>
                <Input value={draft.githubRepo} onChange={(event) => set("githubRepo", event.target.value)} placeholder="software-factory-demo" />
              </div>
              <div className="grid gap-1.5">
                <Label>Base branch</Label>
                <Input value={draft.githubBaseBranch} onChange={(event) => set("githubBaseBranch", event.target.value)} className="font-mono" />
              </div>
              <div className="grid gap-1.5">
                <Label>Personal access token</Label>
                <div className="flex gap-1.5">
                  <Input
                    type="password"
                    value={githubToken}
                    onChange={(event) => setGithubToken(event.target.value)}
                    className="font-mono text-xs"
                    placeholder={draft.hasGithubToken ? "•••••••• configured" : "ghp_… / github_pat_…"}
                  />
                  {draft.hasGithubToken && (
                    <Button variant="ghost" size="icon" onClick={() => void clearSecret("github")} title="Clear token">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4">
              <ToggleRow
                title="Create repository if missing"
                description="When enabled, the orchestrator creates a private repository under the authenticated account before pushing."
                checked={draft.githubCreateRepo}
                onChange={(value) => set("githubCreateRepo", value)}
                icon={<Github className="h-3.5 w-3.5" />}
              />
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
              Tokens are stored locally in <span className="font-mono">.data/factory.json</span> with file mode 600 and never
              written into commit history. Pushes use a temporary askpass helper, not the remote URL.
            </p>
          </section>

          <section className="panel p-4">
            <SectionLabel>Chat routing</SectionLabel>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Default agent (no @mention)</Label>
                <select
                  value={draft.defaultAgentId}
                  onChange={(event) => set("defaultAgentId", event.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-black/20 px-3 text-sm"
                >
                  <option value="">Auto · Product Manager</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.role}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label>Max handoff depth</Label>
                <Input
                  type="number"
                  min="0"
                  max="5"
                  value={draft.maxHandoffDepth}
                  onChange={(event) => set("maxHandoffDepth", Number(event.target.value))}
                  className="font-mono"
                />
              </div>
            </div>
            <div className="mt-4">
              <ToggleRow
                title="Agent-to-agent auto-handoff"
                description="If an agent mentions another specialist in its reply, the orchestrator forwards the payload and original request automatically."
                checked={draft.autoHandoff}
                onChange={(value) => set("autoHandoff", value)}
              />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="panel p-4">
            <SectionLabel>Hardware telemetry</SectionLabel>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-factory-lime/20 bg-factory-lime/5 text-factory-lime">
                  <Cpu className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{health?.hardware.cpu ?? "Apple Silicon"}</div>
                  <div className="font-mono text-[9px] text-muted-foreground">
                    {health?.hardware.arch} · {health?.hardware.cores} cores · {health?.hardware.unifiedMemory ? "unified memory" : "system memory"}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="panel-inset p-2.5">
                  <div className="eyebrow">Installed</div>
                  <div className="font-mono text-sm">{formatMB(memoryTotal)}</div>
                </div>
                <div className="panel-inset p-2.5">
                  <div className="eyebrow">Free</div>
                  <div className="font-mono text-sm">{formatMB(health?.hardware.freeMemoryMB)}</div>
                </div>
                <div className="panel-inset p-2.5">
                  <div className="eyebrow">Usable model</div>
                  <div className="font-mono text-sm">{formatMB(budget)}</div>
                </div>
                <div className="panel-inset p-2.5">
                  <div className="eyebrow">Resident</div>
                  <div className="font-mono text-sm">{formatMB(used)}</div>
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between font-mono text-[9px] text-muted-foreground">
                  <span>queue utilization</span>
                  <span>{Math.round((used / budget) * 100) || 0}%</span>
                </div>
                <Progress value={(used / budget) * 100} className="h-1.5" indicatorClassName={used / budget > 0.85 ? "bg-factory-red" : "bg-factory-lime"} />
              </div>
              <div className="space-y-1 font-mono text-[10px]">
                <div className="flex justify-between"><span className="text-muted-foreground">Running</span><span>{resources?.running.length ?? 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Queued</span><span>{resources?.queued.length ?? 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Heavy slots</span><span>{resources?.heavyRunning ?? 0}/{resources?.maxConcurrentHeavy ?? 1}</span></div>
              </div>
              <Button variant="outline" size="sm" className="w-full" onClick={resetQueue}>
                <Trash2 className="h-3.5 w-3.5" />
                Reset queue reservations
              </Button>
            </div>
          </section>

          <section className="panel p-4">
            <SectionLabel>Local storage</SectionLabel>
            <div className="space-y-2 font-mono text-[10px] text-muted-foreground">
              <div className="flex items-start gap-2">
                <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-factory-cyan" />
                <div>
                  <div className="text-foreground/80">.data/factory.json</div>
                  <div>agents · runs · metrics · threads</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-factory-amber" />
                <div>
                  <div className="text-foreground/80">.data/workspaces/</div>
                  <div>one folder per project</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-factory-lime" />
                <div>
                  <div className="text-foreground/80">allowlisted spawn</div>
                  <div>no shell interpolation · timeout · sanitized env</div>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-factory-amber/20 bg-factory-amber/5 p-4">
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-factory-amber">
              <AlertTriangle className="h-3.5 w-3.5" />
              Safety boundary
            </div>
            <p className="text-[10px] leading-relaxed text-factory-amber/80">
              Generated code executes locally during tests. The factory constrains cwd, command allowlist,
              environment and timeout, but it is not an OS-level sandbox. Review generated projects before
              deploying. Never point the GitHub token at an organisation you do not control.
            </p>
          </section>

          <section className="panel p-4">
            <SectionLabel>Build status</SectionLabel>
            <div className="space-y-2">
              <StatusLine label="Ollama" online={health?.ollama.online} detail={health?.ollama.version} />
              <StatusLine label="OpenCode" online={health?.opencode.online} detail={health?.opencode.version} />
              <StatusLine label="Local models" online={(health?.models.local ?? 0) > 0} detail={`${health?.models.local ?? 0} installed`} />
              <StatusLine label="Cloud catalog" online={health?.models.cloudOnline} detail={`${health?.models.cloud ?? 0} free models`} />
            </div>
            <div className="mt-3 border-t border-border/60 pt-3 font-mono text-[9px] text-muted-foreground">
              <div className="flex justify-between"><span>Process RSS</span><span>{formatMB(health?.process.rssMB)}</span></div>
              <div className="flex justify-between"><span>Uptime</span><span>{Math.floor((health?.process.uptimeSec ?? 0) / 60)}m</span></div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
  icon,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-black/20 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {icon && <span className="mt-0.5 text-muted-foreground">{icon}</span>}
        <div>
          <div className="text-xs font-medium">{title}</div>
          <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{description}</div>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function StatusLine({
  label,
  online,
  detail,
}: {
  label: string;
  online?: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between font-mono text-[10px]">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span className={cn("h-1.5 w-1.5 rounded-full", online ? "bg-factory-lime" : "bg-factory-red/70")} />
        {label}
      </span>
      <span className={online ? "text-foreground/80" : "text-muted-foreground/50"}>{detail ?? (online ? "online" : "offline")}</span>
    </div>
  );
}
