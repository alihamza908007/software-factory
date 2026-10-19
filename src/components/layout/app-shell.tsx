"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Bot,
  Boxes,
  CircuitBoard,
  Command,
  GitBranch,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Plus,
  Settings,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { cn, formatMB } from "@/lib/utils";
import { useFactory } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { GlobalRunLauncher, launchRunDialog } from "@/components/shared/run-launcher";

const NAV = [
  { href: "/", label: "Command Center", icon: LayoutDashboard, key: "overview" },
  { href: "/agents", label: "Agent Manager", icon: Bot, key: "agents" },
  { href: "/chat", label: "Chat Matrix", icon: MessagesSquare, key: "chat" },
  { href: "/pipeline", label: "SDLC Pipeline", icon: CircuitBoard, key: "pipeline" },
  { href: "/projects", label: "Projects", icon: Boxes, key: "projects" },
  { href: "/settings", label: "Settings", icon: Settings, key: "settings" },
];

const TITLES: Record<string, { title: string; eyebrow: string }> = {
  "/": { title: "Command Center", eyebrow: "Factory floor / live operations" },
  "/agents": { title: "Agent Manager", eyebrow: "Workforce / model routing" },
  "/chat": { title: "Chat Matrix", eyebrow: "Coordination / multi-agent channel" },
  "/pipeline": { title: "SDLC Pipeline", eyebrow: "Execution / five-phase automation" },
  "/projects": { title: "Projects", eyebrow: "Workspaces / artifacts" },
  "/settings": { title: "Settings", eyebrow: "Hardware / providers / guardrails" },
};

function FactoryMark() {
  return (
    <div className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-factory-lime/30 bg-factory-lime/10">
      <div className="absolute inset-[5px] rounded-sm border border-factory-lime/40" />
      <FactoryGlyph className="h-5 w-5 text-factory-lime" />
    </div>
  );
}

function FactoryGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4 20V9l5 3V9l5 3V7l6 4v9H4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 20v-3h3v3M15 20v-3h2v3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 7h4V5H4v2Z" fill="currentColor" opacity=".8" />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const {
    refreshAll,
    fetchHealth,
    fetchResources,
    fetchRuns,
    health,
    resources,
    agents,
    modelsLoaded,
    fetchModels,
    runs,
  } = useFactory();

  useEffect(() => {
    void refreshAll();
    const interval = setInterval(() => {
      void fetchHealth();
      void fetchResources();
      void fetchRuns();
    }, 7000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!modelsLoaded) void fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoaded]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const meta = TITLES[pathname] ?? TITLES["/"];
  const budget = resources?.budgetMB ?? 36864;
  const used = resources?.usedMB ?? 0;
  const pct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  const activeRuns = useMemo(
    () => runs.filter((run) => run.status === "running" || run.status === "queued"),
    [runs],
  );

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-3 border-b border-border/60 px-5">
        <FactoryMark />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-tight">SOFTWARE FACTORY</div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Apple Silicon · local-first
          </div>
        </div>
      </div>

      <div className="px-3 pt-5">
        <div className="mb-2 px-2 eyebrow">Factory</div>
        <nav className="space-y-0.5">
          {NAV.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors",
                  active
                    ? "bg-factory-lime/10 text-factory-lime"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                <Icon className={cn("h-4 w-4", active ? "text-factory-lime" : "text-muted-foreground/80")} />
                <span className="flex-1">{item.label}</span>
                {item.key === "pipeline" && activeRuns.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-factory-amber px-1 font-mono text-[9px] font-bold text-black">
                    {activeRuns.length}
                  </span>
                )}
                {active && <span className="h-1 w-1 rounded-full bg-factory-lime" />}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="mt-5 px-3">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="eyebrow">Workforce</span>
          <Badge variant="outline">{agents.filter((agent) => agent.enabled).length} online</Badge>
        </div>
        <div className="space-y-1 px-1">
          {agents.slice(0, 5).map((agent) => (
            <Link
              key={agent.id}
              href={`/agents?agent=${agent.id}`}
              className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full font-mono text-[9px] font-bold text-black"
                style={{ backgroundColor: agent.color }}
              >
                {agent.name.slice(0, 1)}
              </span>
              <span className="flex-1 truncate">{agent.name}</span>
              <span className="max-w-[72px] truncate font-mono text-[9px] opacity-60">
                {agent.modelKey.split("/")[1]?.split(":")[0]}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-auto space-y-3 border-t border-border/60 p-4">
        <div className="panel-inset p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Unified memory</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {formatMB(used)} / {formatMB(budget)}
            </span>
          </div>
          <Progress
            value={pct}
            className="h-1.5"
            indicatorClassName={pct > 85 ? "bg-factory-red" : pct > 60 ? "bg-factory-amber" : "bg-factory-lime"}
          />
          <div className="mt-2 flex items-center justify-between font-mono text-[9px] text-muted-foreground">
            <span>{resources?.heavyRunning ?? 0} heavy active</span>
            <span>{resources?.queued.length ?? 0} queued</span>
          </div>
        </div>
        <div className="flex items-center justify-between px-1 font-mono text-[10px]">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", health?.ollama.online ? "bg-factory-lime" : "bg-factory-red")} />
            Ollama
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", health?.opencode.online ? "bg-factory-cyan" : "bg-factory-red")} />
            OpenCode
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            {activeRuns[0]?.git.branch ? "branch" : "main"}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-0 bg-radial-fade" />
      <div className="pointer-events-none fixed inset-0 factory-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_85%)]" />

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-border/60 bg-[#0a0d0b]/95 backdrop-blur-xl lg:block">
        {sidebar}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] border-r border-border bg-[#0a0d0b]">
            <button
              className="absolute right-3 top-4 z-10 rounded-md p-1 text-muted-foreground hover:bg-white/5"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="relative lg:pl-[248px]">
        <header className="sticky top-0 z-30 border-b border-border/60 bg-background/75 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-3 px-4 md:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="eyebrow hidden sm:block">{meta.eyebrow}</div>
              <div className="flex items-center gap-2">
                <h1 className="truncate text-base font-semibold tracking-tight">{meta.title}</h1>
                {activeRuns.length > 0 && (
                  <Badge variant="warning" className="hidden sm:inline-flex">
                    <span className="h-1 w-1 animate-pulse rounded-full bg-factory-amber" />
                    {activeRuns.length} running
                  </Badge>
                )}
              </div>
            </div>

            <div className="hidden items-center gap-2 md:flex">
              <div className="panel-inset flex items-center gap-2 px-2.5 py-1.5">
                <Activity className="h-3.5 w-3.5 text-factory-lime" />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {health?.models.local ?? 0} local · {health?.models.cloud ?? 0} cloud
                </span>
              </div>
              <div className="panel-inset flex items-center gap-2 px-2.5 py-1.5">
                <Command className="h-3.5 w-3.5 text-factory-cyan" />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {health?.hardware.cores ?? "—"} cores
                </span>
              </div>
            </div>

            <Button size="sm" onClick={() => launchRunDialog()}>
              <Plus className="h-3.5 w-3.5" />
              New run
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1500px] px-4 py-6 md:px-6 lg:px-8">{children}</main>

        <footer className="mx-auto flex w-full max-w-[1500px] flex-col gap-2 px-4 pb-6 text-[10px] text-muted-foreground md:flex-row md:items-center md:justify-between md:px-6 lg:px-8">
          <span className="flex items-center gap-2 font-mono">
            <Sparkles className="h-3 w-3 text-factory-lime" />
            LOCAL-FIRST · {health?.hardware.cpu ?? "Apple Silicon"}
          </span>
          <span className="flex items-center gap-3 font-mono">
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3 text-factory-amber" />
              {health?.process.uptimeSec ? `${Math.floor(health.process.uptimeSec / 60)}m uptime` : "—"}
            </span>
            <span>VRAM guard {health?.resources.maxConcurrentHeavy ?? 1} heavy max</span>
          </span>
        </footer>
      </div>

      <GlobalRunLauncher />
    </div>
  );
}
