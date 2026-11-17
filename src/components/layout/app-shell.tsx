"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Boxes,
  CircuitBoard,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Moon,
  Plus,
  RotateCcw,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { cn } from "@/lib/core/utils";
import { useFactory } from "@/lib/data/store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GlobalRunLauncher, launchRunDialog } from "@/components/shared/run-launcher";

const NAV = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: Boxes },
  { href: "/pipeline", label: "Runs", icon: CircuitBoard },
  { href: "/chat", label: "Chat", icon: MessagesSquare },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

function BrandMark() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
        <path
          d="M4 20V9l5 3V9l5 3V7l6 4v9H4Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M8 20v-3h3v3M15 20v-3h2v3" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("factory-theme");
      if (stored === "dark") setTheme("dark");
    } catch {}
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    try {
      localStorage.setItem("factory-theme", theme);
    } catch {}
  }, [theme]);

  const {
    refreshAll,
    fetchHealth,
    fetchRuns,
    health,
    modelsLoaded,
    fetchModels,
    runs,
    connectMesh,
    meshEvents,
    meshConnected,
  } = useFactory();
  const knownResponseEvents = useRef<Set<string> | null>(null);

  useEffect(() => {
    void refreshAll();
    connectMesh();
    const interval = setInterval(() => {
      void fetchHealth();
      void fetchRuns();
    }, 7000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!meshConnected) return;
    if (!knownResponseEvents.current) {
      knownResponseEvents.current = new Set(meshEvents.map((event) => event.id));
      return;
    }
    for (const event of meshEvents) {
      if (knownResponseEvents.current.has(event.id)) continue;
      knownResponseEvents.current.add(event.id);
      if (event.type !== "TASK_CONTRACT" || event.title !== "Agent response delivered") continue;
      if (pathname === "/chat") continue;
      const excerpt = event.message.replace(/\s+/g, " ").trim();
      toast.message(`${event.source} responded`, {
        description: excerpt.length > 220 ? `${excerpt.slice(0, 217)}…` : excerpt,
        duration: 5_000,
      });
    }
    if (knownResponseEvents.current.size > 600) {
      knownResponseEvents.current = new Set(meshEvents.slice(-300).map((event) => event.id));
    }
  }, [meshConnected, meshEvents, pathname]);

  useEffect(() => {
    if (!modelsLoaded) void fetchModels();
    const discovery = setInterval(() => {
      if (document.visibilityState === "visible") void fetchModels(true);
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchModels(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(discovery);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoaded]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const activeRuns = useMemo(
    () => runs.filter((run) => run.status === "running" || run.status === "queued"),
    [runs],
  );
  const recoverableRuns = useMemo(
    () => runs.filter((run) => run.status === "recoverable_paused" || run.status === "interrupted"),
    [runs],
  );

  async function resumeRun(runId: string) {
    setResumingRunId(runId);
    try {
      const response = await fetch(`/api/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not resume this run.");
      await fetchRuns();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setResumingRunId(null);
    }
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 px-4">
        <BrandMark />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-tight">Software Factory</div>
          <div className="truncate text-[11px] text-muted-foreground">Local-first</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-2 pt-2">
        {NAV.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("h-4 w-4", active ? "text-foreground" : "text-muted-foreground")} />
              <span className="flex-1">{item.label}</span>
              {item.href === "/pipeline" && activeRuns.length > 0 && (
                <Badge variant="warning" className="h-5 px-1.5 text-xs">
                  {activeRuns.length}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-border p-3">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                health?.ollama.online ? "bg-factory-lime" : "bg-factory-red/70",
              )}
            />
            Ollama
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                health?.opencode.online ? "bg-factory-lime" : "bg-factory-red/70",
              )}
            />
            OpenCode
          </span>
        </div>
        <Button className="w-full justify-start" size="sm" onClick={() => launchRunDialog()}>
          <Plus className="h-3.5 w-3.5" />
          New run
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[216px] border-r border-border bg-background lg:block">
        {sidebar}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-foreground/20 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[260px] border-r border-border bg-background">
            <button
              className="absolute right-2 top-3 z-10 rounded-md p-2 text-muted-foreground hover:bg-secondary"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="relative lg:pl-[216px]">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-[1360px] items-center gap-3 px-4 md:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-sm font-semibold lg:hidden">Software Factory</span>
              {activeRuns.length > 0 && (
                <Badge variant="warning" className="hidden sm:inline-flex">
                  {activeRuns.length} running
                </Badge>
              )}
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>

            <Button size="sm" className="hidden sm:inline-flex" onClick={() => launchRunDialog()}>
              <Plus className="h-3.5 w-3.5" />
              New run
            </Button>
          </div>
        </header>

        {recoverableRuns.length > 0 && (
          <div className="mx-auto mt-4 w-full max-w-[1360px] px-4 md:px-6">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/50 px-3 py-2.5">
              <RotateCcw className="h-4 w-4 shrink-0 text-factory-amber" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">
                  {recoverableRuns.length} run{recoverableRuns.length === 1 ? " was" : "s were"} paused after a restart
                </div>
                <div className="text-[11px] text-muted-foreground">Resume from the last saved phase.</div>
              </div>
              {recoverableRuns.slice(0, 3).map((run) => (
                <Button
                  key={run.id}
                  size="sm"
                  variant="outline"
                  onClick={() => void resumeRun(run.id)}
                  disabled={resumingRunId === run.id}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Resume {run.projectName}
                </Button>
              ))}
              {recoverableRuns.length > 3 && (
                <Link href="/pipeline" className="text-[11px] text-muted-foreground hover:text-foreground">
                  View all
                </Link>
              )}
            </div>
          </div>
        )}

        <main className="mx-auto w-full max-w-[1360px] px-4 py-8 md:px-6">{children}</main>
      </div>

      <GlobalRunLauncher />
    </div>
  );
}
