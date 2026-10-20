"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ValidatorFlowNode } from "./types";

export function ValidatorNode({ data, selected }: NodeProps<ValidatorFlowNode>) {
  const failed = data.status === "failed" || data.status === "blocked";
  return (
    <div
      className={cn(
        "w-[210px] rounded-xl border bg-[#0c1112] shadow-xl",
        selected ? "border-factory-cyan/60" : "border-border/80",
        data.status === "running" && "border-factory-amber/60",
        failed && "border-factory-red/60",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-factory-cyan !bg-factory-cyan" />
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-factory-cyan/20 bg-factory-cyan/5 text-factory-cyan">
          <ShieldCheck className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{data.label}</div>
          <div className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
            validator gate
          </div>
        </div>
        {data.status === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin text-factory-amber" />
        ) : data.status === "passed" ? (
          <CheckCircle2 className="h-3 w-3 text-factory-lime" />
        ) : failed ? (
          <XCircle className="h-3 w-3 text-factory-red" />
        ) : null}
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        <div className="font-mono text-[9px] leading-relaxed text-factory-cyan/90">
          {data.assertion || "No assertion configured"}
        </div>
        {data.detail && (
          <div className="line-clamp-2 text-[9px] text-muted-foreground">{data.detail}</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-factory-cyan !bg-factory-cyan" />
    </div>
  );
}
