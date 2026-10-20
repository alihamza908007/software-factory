"use client";

import { Cloud, Cpu, Server } from "lucide-react";
import type { ModelInfo } from "@/lib/types";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, formatMB } from "@/lib/utils";

export function ModelSelect({
  value,
  onChange,
  models,
  placeholder = "Select a model",
  className,
  allowNone = false,
  noneLabel = "No fallback",
}: {
  value: string;
  onChange: (value: string) => void;
  models: ModelInfo[];
  placeholder?: string;
  className?: string;
  allowNone?: boolean;
  noneLabel?: string;
}) {
  const local = models.filter((model) => model.kind === "local");
  const cloud = models.filter((model) => model.kind === "cloud");
  return (
    <Select value={value || "__none"} onValueChange={(next) => onChange(next === "__none" ? "" : next)}>
      <SelectTrigger className={cn("font-mono text-[11px]", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && (
          <SelectItem value="__none">
            <span className="text-muted-foreground">{noneLabel}</span>
          </SelectItem>
        )}
        {local.length > 0 && (
          <SelectGroup>
            <SelectLabel>
              <span className="inline-flex items-center gap-1.5">
                <Cpu className="h-3 w-3" /> Local · Ollama / LM Studio
              </span>
            </SelectLabel>
            {local.map((model) => (
              <SelectItem key={model.key} value={model.key}>
                <span className="flex w-full items-center gap-2">
                  <span className="max-w-[240px] truncate">{model.name}</span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {model.provider} · {model.parameterSize ? `${model.parameterSize} · ` : ""}
                    {formatMB(model.vramEstimateMB)}
                    {model.heavy ? " · heavy" : ""}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {cloud.length > 0 && (
          <SelectGroup>
            <SelectLabel>
              <span className="inline-flex items-center gap-1.5">
                <Cloud className="h-3 w-3" /> Cloud · OpenCode / OpenRouter / Anthropic / OpenAI / Gemini
              </span>
            </SelectLabel>
            {cloud.map((model) => (
              <SelectItem key={model.key} value={model.key}>
                <span className="flex w-full items-center gap-2">
                  <span className="max-w-[240px] truncate">{model.name}</span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                    {model.provider} · {model.zeroCost ? "free" : `$${model.costInputPerMTok}/M`}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {!local.length && !cloud.length && (
          <SelectItem value="__empty" disabled>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Server className="h-3 w-3" /> No models discovered
            </span>
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
