"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bot, CheckCircle2, Cloud, Cpu, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentFlowNode } from "./types";

function statusIcon(status?: string) {
  if (status === "running") return <Loader2 className="h-3 w-3 animate-spin text-factory-amber" />;
  if (status === "passed") return <CheckCircle2 className="h-3 w-3 text-factory-lime" />;
  if (status === "failed" || status === "blocked") return <XCircle className="h-3 w-3 text-factory-red" />;
  return <span className="h-2 w-2 rounded-full bg-muted-foreground" />;
}

export function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const local = data.provider === "ollama" || data.provider === "lmstudio";
  return (
    <div
      className={cn(
        "w-[230px] rounded-xl border bg-card shadow-xl transition-colors",
        selected ? "border-factory-lime/60" : "border-border/80",
        data.status === "running" && "border-factory-amber/60",
        data.status === "failed" && "border-factory-red/60",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-factory-cyan !bg-factory-cyan" />
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-factory-lime/20 bg-factory-lime/5 text-factory-lime">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{data.label}</div>
          <div className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
            agent node
          </div>
        </div>
        {statusIcon(data.status)}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
          {local ? <Cpu className="h-3 w-3 text-factory-amber" /> : <Cloud className="h-3 w-3 text-factory-cyan" />}
          <span className="truncate">{data.modelKey ?? "model inherited from agent"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded border border-border/70 bg-secondary/50 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
            {data.provider ?? "auto"}
          </span>
          {typeof data.guardrailScore === "number" && (
            <span className="rounded border border-factory-lime/20 bg-factory-lime/5 px-1.5 py-0.5 font-mono text-[8px] text-factory-lime">
              {data.guardrailScore}/100
            </span>
          )}
          <span className="ml-auto truncate font-mono text-[8px] text-muted-foreground/70">
            {data.status ?? "idle"}
          </span>
        </div>
        {data.detail && (
          <div className="line-clamp-2 rounded bg-secondary/50 px-2 py-1 text-[9px] leading-relaxed text-muted-foreground">
            {data.detail}
          </div>
        )}
        {(data.durationMs || data.tokens) && (
          <div className="flex items-center gap-2 font-mono text-[8px] text-muted-foreground">
            {data.durationMs ? <span>{Math.round(data.durationMs)} ms</span> : null}
            {data.tokens ? <span>{data.tokens} tok</span> : null}
          </div>
        )}
        {data.error && (
          <div className="line-clamp-2 rounded border border-red-400/20 bg-red-400/5 px-2 py-1 text-[8px] leading-relaxed text-red-300">
            {data.error}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-factory-lime !bg-factory-lime" />
    </div>
  );
}
