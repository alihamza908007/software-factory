"use client";

import {
  AlertTriangle,
  Brain,
  Loader2,
  Pause,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useFactory } from "@/lib/data/store";
import type { Agent, MeshAgentStatus } from "@/lib/core/types";
import { cn } from "@/lib/core/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";

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

export function AgentNodeCard({ agent }: { agent: Agent }) {
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
