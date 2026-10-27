"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitBranch, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RouterFlowNode } from "./types";

export function RouterNode({ data, selected }: NodeProps<RouterFlowNode>) {
  return (
    <div
      className={cn(
        "w-[190px] rounded-xl border bg-card shadow-xl",
        selected ? "border-factory-amber/60" : "border-border/80",
        data.status === "running" && "border-factory-amber/60",
        data.status === "failed" && "border-factory-red/60",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-factory-amber !bg-factory-amber" />
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-factory-amber/20 bg-factory-amber/5 text-factory-amber">
          <GitBranch className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{data.label}</div>
          <div className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
            router
          </div>
        </div>
        {data.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-factory-amber" />}
        {data.status === "failed" && <XCircle className="h-3 w-3 text-factory-red" />}
      </div>
      <div className="px-3 py-2.5 font-mono text-[9px] leading-relaxed text-factory-amber/90">
        {data.condition || "score>=70"}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-factory-amber !bg-factory-amber" />
    </div>
  );
}
