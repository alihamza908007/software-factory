"use client";

import { Cloud, Cpu, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/types";

export function ProviderIcon({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  if (provider === "ollama") return <Cpu className={cn("h-3 w-3", className)} />;
  if (provider === "opencode") return <Cloud className={cn("h-3 w-3", className)} />;
  return <Server className={cn("h-3 w-3", className)} />;
}

export function ModelBadge({
  model,
  modelKey,
  compact = false,
  className,
}: {
  model?: ModelInfo;
  modelKey: string;
  compact?: boolean;
  className?: string;
}) {
  const provider = model?.provider ?? (modelKey.split("/")[0] as ModelInfo["provider"]);
  const name = model?.name ?? modelKey.split("/").slice(1).join("/");
  const isLocal = provider === "ollama";
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-1 font-mono text-[10px]",
        isLocal
          ? "border-factory-amber/25 bg-factory-amber/5 text-factory-amber"
          : "border-factory-cyan/25 bg-factory-cyan/5 text-factory-cyan",
        className,
      )}
      title={`${modelKey}${model ? ` · ${model.parameterSize ?? ""} ${model.quantization ?? ""}` : ""}`}
    >
      <ProviderIcon provider={provider} />
      <span className="truncate">{name}</span>
      {!compact && model?.heavy && <span className="text-[8px] opacity-70">HEAVY</span>}
    </span>
  );
}
