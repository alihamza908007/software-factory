"use client";

import { useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import type { Run } from "@/lib/core/types";
import { cn } from "@/lib/core/utils";
import { Badge } from "@/components/ui/badge";

export function AllLogs({ run }: { run: Run }) {
  const [level, setLevel] = useState<string>("all");
  const logs = useMemo(
    () =>
      run.phases
        .flatMap((phase) =>
          phase.logs.map((log) => ({ ...log, phase: phase.name, phaseId: phase.id })),
        )
        .sort((a, b) => a.at - b.at)
        .filter((log) => level === "all" || log.level === level),
    [run, level],
  );
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-factory-lime" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            factory.log
          </span>
          <Badge variant="outline">{logs.length}</Badge>
        </div>
        <div className="flex gap-1">
          {["all", "success", "error", "command", "agent"].map((value) => (
            <button
              key={value}
              onClick={() => setLevel(value)}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider",
                level === value ? "bg-factory-lime/10 text-factory-lime" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[520px] overflow-y-auto p-3 font-mono">
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2 border-b border-border/20 py-1.5 text-[10px] last:border-0">
            <span className="w-16 shrink-0 text-muted-foreground/50">
              {new Date(log.at).toLocaleTimeString([], { hour12: false })}
            </span>
            <span
              className={cn(
                "w-14 shrink-0 uppercase",
                log.level === "error"
                  ? "text-factory-red"
                  : log.level === "success"
                    ? "text-factory-lime"
                    : log.level === "warn"
                      ? "text-factory-amber"
                      : log.level === "command"
                        ? "text-factory-cyan"
                        : "text-muted-foreground/60",
              )}
            >
              {log.level}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground/80">{log.message}</span>
              {log.detail && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[9px] leading-relaxed text-muted-foreground/70">
                  {log.detail}
                </pre>
              )}
            </span>
          </div>
        ))}
        {!logs.length && <div className="py-12 text-center text-xs text-muted-foreground">No log lines match.</div>}
      </div>
    </div>
  );
}
