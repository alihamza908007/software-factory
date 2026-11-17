"use client";

import { ChevronRight, Circle, Wrench } from "lucide-react";
import { PHASES, SDLC_PHASE_META } from "@/lib/core/constants";
import type { Agent, ModelInfo, PhaseId, PhaseState, Run } from "@/lib/core/types";
import { cn } from "@/lib/core/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ModelBadge } from "@/components/shared/model-badge";
import { StatusPill } from "@/components/shared/status";
import { Progress } from "@/components/ui/progress";

export function PhaseColumn({
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
  agents: Agent[];
  models: ModelInfo[];
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
          <span className="font-mono text-[11px] tracking-wide" style={{ color: meta.accent }}>
            {meta.short} · 0{meta.index}
          </span>
          <StatusPill status={status} kind="phase" />
        </div>
        <div className="mt-1 text-xs font-medium">{definition.name}</div>
        <div className="mt-2 flex items-center gap-1.5">
          {agent ? (
            <>
              <AgentAvatar name={agent.name} color={agent.color} icon={agent.icon} size="sm" />
              <span className="truncate text-xs">{agent.name}</span>
              <ModelBadge model={model} modelKey={agent.modelKey} compact className="ml-auto max-w-[90px]" />
            </>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">{definition.agentRole}</span>
          )}
        </div>
      </div>
      <div className="flex-1 space-y-2.5 p-3">
        <p className="min-h-[48px] text-xs leading-relaxed text-muted-foreground">{definition.description}</p>
        <div>
          <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
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
              <span key={artifact} className="max-w-full truncate rounded border border-border/60 bg-secondary/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {artifact}
              </span>
            ))}
          </div>
        )}

        {!!phase?.healAttempts.length && (
          <div className="rounded border border-factory-amber/20 bg-factory-amber/5 px-2 py-1.5">
            <div className="flex items-center gap-1 font-mono text-[10px] tracking-wide text-factory-amber">
              <Wrench className="h-2.5 w-2.5" />
              {phase.healAttempts.length} heal {phase.healAttempts.length === 1 ? "loop" : "loops"}
            </div>
            {phase.healAttempts.slice(-2).map((attempt) => (
              <div key={attempt.attempt} className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                #{attempt.attempt} {attempt.appliedFiles.length} files · {attempt.result}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1">
          {lastLogs.map((log) => (
            <div key={log.id} className="flex gap-1.5 text-[11px] leading-snug">
              <span
                className={cn(
                  "mt-1 h-1 w-1 shrink-0 rounded-full",
                  log.level === "error"
                    ? "bg-factory-red"
                    : log.level === "success"
                      ? "bg-factory-lime"
                      : log.level === "warn"
                        ? "bg-factory-amber"
                        : "bg-muted-foreground",
                )}
              />
              <span className="line-clamp-2 text-muted-foreground">{log.message}</span>
            </div>
          ))}
          {!lastLogs.length && (
            <div className="flex items-center gap-1.5 py-2 text-[11px] text-muted-foreground/60">
              <Circle className="h-2 w-2" />
              waiting for upstream phase
            </div>
          )}
        </div>
      </div>
      <button
        onClick={() => onInspect(phaseId)}
        className="flex items-center justify-between border-t border-border/60 px-3 py-2 font-mono text-[10px] tracking-wide text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
      >
        Inspect trace
        <ChevronRight className="h-3 w-3" />
      </button>
    </section>
  );
}
