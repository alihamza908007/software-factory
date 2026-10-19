"use client";

import {
  Bot,
  ClipboardList,
  Code2,
  Network,
  Rocket,
  ShieldCheck,
  Sparkles,
  UserCog,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Bot,
  ClipboardList,
  Code2,
  Network,
  Rocket,
  ShieldCheck,
  Sparkles,
  UserCog,
};

export function AgentIcon({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) {
  const Icon = ICONS[name ?? "Bot"] ?? Bot;
  return <Icon className={cn("h-4 w-4", className)} />;
}

export function AgentAvatar({
  name,
  color,
  size = "md",
  icon,
  className,
}: {
  name: string;
  color: string;
  size?: "sm" | "md" | "lg";
  icon?: string;
  className?: string;
}) {
  const dims = size === "sm" ? "h-6 w-6 text-[9px]" : size === "lg" ? "h-10 w-10 text-sm" : "h-8 w-8 text-[11px]";
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full font-mono font-bold text-black",
        dims,
        className,
      )}
      style={{ backgroundColor: color }}
      title={name}
    >
      {icon ? <AgentIcon name={icon} className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} /> : name.slice(0, 2).toUpperCase()}
      <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/20" />
    </span>
  );
}
