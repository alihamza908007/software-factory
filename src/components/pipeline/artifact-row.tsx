"use client";

import { FileCode2 } from "lucide-react";
import { cn } from "@/lib/core/utils";

export function ArtifactRow({ label, path, exists }: { label: string; path: string; exists: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border/50 bg-secondary/50 px-2 py-1.5">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <FileCode2 className="h-3 w-3" />
        {label}
      </span>
      <span className={cn("max-w-[180px] truncate font-mono text-[9px]", exists ? "text-factory-lime" : "text-muted-foreground/50")}>
        {exists ? path : "not generated"}
      </span>
    </div>
  );
}
