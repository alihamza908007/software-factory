"use client";

import { useEffect, useState } from "react";
import { BarChart3, Loader2, RefreshCw } from "lucide-react";
import type { AgentAnalytics } from "@/lib/core/types";
import { cn, formatTokens, timeAgo } from "@/lib/core/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

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

export function AnalyticsDrawer({
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
