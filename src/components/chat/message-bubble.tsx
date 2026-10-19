"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight, Bot, CircleAlert, CornerDownRight, Loader2, Sparkles, Wrench } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { cn, formatCost, formatDuration, formatTokens, timeAgo } from "@/lib/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { Badge } from "@/components/ui/badge";

export function MessageBubble({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  if (message.role === "system") {
    return (
      <div className="mx-auto flex max-w-xl items-start gap-2 rounded-lg border border-factory-lime/20 bg-factory-lime/5 px-3 py-2 text-[11px] text-foreground/80">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-factory-lime" />
        <div className="min-w-0 flex-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]} className="markdown-body text-[11px]">
            {message.content}
          </ReactMarkdown>
          {message.runId && (
            <a href={`/pipeline?run=${message.runId}`} className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-factory-lime hover:underline">
              Open pipeline <ArrowRight className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end gap-2.5">
        <div className="max-w-[82%]">
          <div className="mb-1 text-right font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            You · {timeAgo(message.createdAt)}
          </div>
          <div className="rounded-xl rounded-tr-sm border border-factory-lime/20 bg-factory-lime/10 px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
            {message.content.split("\n").map((line, index) => (
              <p key={index} className={index > 0 ? "mt-1" : undefined}>
                {line}
              </p>
            ))}
          </div>
          {!!message.mentions?.length && (
            <div className="mt-1 flex flex-wrap justify-end gap-1">
              {message.mentions.map((mention) => (
                <span key={mention} className="font-mono text-[9px] text-factory-cyan">@{mention}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary font-mono text-[10px] text-muted-foreground">
          YOU
        </div>
      </div>
    );
  }

  const color = message.agentColor ?? "#6fe7dd";
  return (
    <div className="flex gap-2.5">
      <AgentAvatar name={message.agentName ?? "Agent"} color={color} size="md" />
      <div className="min-w-0 max-w-[88%] flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium" style={{ color }}>
            {message.agentName ?? "Agent"}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">{timeAgo(message.createdAt)}</span>
          {message.handoffFrom && (
            <span className="inline-flex items-center gap-1 rounded-full border border-factory-cyan/25 bg-factory-cyan/5 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-factory-cyan">
              <CornerDownRight className="h-2.5 w-2.5" />
              handoff from {message.handoffFrom}
            </span>
          )}
          {message.pending && (
            <span className="inline-flex items-center gap-1 font-mono text-[9px] text-factory-amber">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              {message.content ? "streaming" : "thinking"}
            </span>
          )}
          {message.error && <Badge variant="destructive"><CircleAlert className="h-2.5 w-2.5" /> error</Badge>}
        </div>

        <div
          className={cn(
            "rounded-xl rounded-tl-sm border px-3.5 py-2.5",
            message.error
              ? "border-red-400/25 bg-red-400/5"
              : "border-border/70 bg-card/70",
          )}
        >
          {message.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} className="markdown-body">
              {message.content}
            </ReactMarkdown>
          ) : (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
              </span>
              dispatching to {message.agentName}…
            </div>
          )}
          {streaming && message.pending && <span className="ml-0.5 inline-block h-3 w-1 animate-blink bg-factory-lime" />}
        </div>

        {message.metrics && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Bot className="h-2.5 w-2.5" />
              {message.metrics.modelKey}
            </span>
            <span>TTFT {formatDuration(message.metrics.ttftMs)}</span>
            <span>total {formatDuration(message.metrics.totalMs)}</span>
            <span className="text-factory-lime">{message.metrics.tokensPerSec.toFixed(1)} tok/s</span>
            <span>{formatTokens(message.metrics.outputTokens)} out</span>
            <span>{formatCost(message.metrics.costUsd)}</span>
            {message.metrics.vramMB > 0 && <span>{Math.round(message.metrics.vramMB)} MB VRAM</span>}
            {(message.metrics as { fellBack?: boolean }).fellBack && (
              <span className="flex items-center gap-0.5 text-factory-amber">
                <Wrench className="h-2.5 w-2.5" /> fallback
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
