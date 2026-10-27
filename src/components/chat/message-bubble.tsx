"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight, Bot, Check, CircleAlert, CornerDownRight, FileCode2, Loader2, Pencil, RotateCcw, ShieldAlert, ShieldCheck, Sparkles, Wrench, X } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { cn, formatCost, formatDuration, formatTokens, timeAgo } from "@/lib/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export function MessageBubble({
  message,
  streaming,
  onEdit,
  onContinueEdit,
}: {
  message: ChatMessage;
  streaming?: boolean;
  onEdit?: (message: ChatMessage, content: string) => Promise<void>;
  onContinueEdit?: (message: ChatMessage, content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  async function commit(continueWork: boolean) {
    if (!onEdit || !draft.trim()) return;
    setSaving(true);
    try {
      await onEdit(message, draft);
      setEditing(false);
      if (continueWork && onContinueEdit) await onContinueEdit(message, draft);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

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
      <div className="flex min-w-0 max-w-full justify-end gap-2.5">
        <div className="min-w-0 max-w-[82%] flex-1">
          <div className="mb-1 text-right font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            You · {timeAgo(message.createdAt)}
          </div>
          {editing ? (
            <div className="w-full max-w-full rounded-xl border border-factory-lime/20 bg-factory-lime/5 p-2">
              <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={5} className="w-full min-w-0 resize-y text-xs" />
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X className="h-3 w-3" />Cancel</Button>
                <Button size="sm" variant="outline" onClick={() => void commit(false)} disabled={saving}><Check className="h-3 w-3" />Save</Button>
                {onContinueEdit && <Button size="sm" onClick={() => void commit(true)} disabled={saving}><RotateCcw className="h-3 w-3" />Save & continue</Button>}
              </div>
            </div>
          ) : (
            <div className="max-w-full overflow-hidden rounded-xl rounded-tr-sm border border-factory-lime/20 bg-factory-lime/10 px-3.5 py-2.5 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
              {onEdit && !message.pending && <button className="mt-1 flex items-center gap-1 font-mono text-[9px] text-muted-foreground hover:text-foreground" onClick={() => { setDraft(message.content); setEditing(true); }}><Pencil className="h-2.5 w-2.5" />Edit payload</button>}
            </div>
          )}
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
    <div className="flex w-full min-w-0 max-w-full gap-2.5">
      <div className="shrink-0"><AgentAvatar name={message.agentName ?? "Agent"} color={color} size="md" /></div>
      <div className="min-w-0 max-w-full flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium" style={{ color }}>
            {message.agentName ?? "Agent"}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">{timeAgo(message.createdAt)}</span>
          {message.handoffFrom && (
            <span className="inline-flex items-center gap-1 rounded-full border border-factory-cyan/25 bg-factory-cyan/5 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-factory-cyan">
              <CornerDownRight className="h-2.5 w-2.5" />
              handoff from {message.handoffFrom}
              {typeof message.handoffScore === "number" && ` · ${message.handoffScore}/100`}
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
            "min-w-0 max-w-full overflow-hidden rounded-xl rounded-tl-sm border px-3.5 py-2.5",
            message.error
              ? "border-red-400/25 bg-red-400/5"
              : "border-border/70 bg-card/70",
          )}
        >
          {editing ? (
            <div>
              <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={8} className="resize-y text-xs" />
              <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X className="h-3 w-3" />Cancel</Button>
                <Button size="sm" variant="outline" onClick={() => void commit(false)} disabled={saving}><Check className="h-3 w-3" />Save</Button>
                {onContinueEdit && <Button size="sm" onClick={() => void commit(true)} disabled={saving}><RotateCcw className="h-3 w-3" />Save & continue</Button>}
              </div>
            </div>
          ) : message.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} className="markdown-body min-w-0 max-w-full break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
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

        {!!message.artifacts?.length && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center gap-1 font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
              <FileCode2 className="h-2.5 w-2.5 text-factory-cyan" />
              {message.artifacts.length} artifact{message.artifacts.length === 1 ? "" : "s"}
            </span>
            {message.artifacts.slice(0, 8).map((path) => (
              <Badge key={path} variant="outline" className="max-w-[240px] truncate font-mono text-[8px]" title={path}>
                {path}
              </Badge>
            ))}
          </div>
        )}

        {message.validation && (
          <div className="mt-1.5">
            <Badge
              variant={message.validation.passed ? "success" : "warning"}
              title={message.validation.topFinding ?? "Silent Witness result"}
              className="gap-1 font-mono text-[8px]"
            >
              {message.validation.passed ? (
                <ShieldCheck className="h-2.5 w-2.5" />
              ) : (
                <ShieldAlert className="h-2.5 w-2.5" />
              )}
              Silent Witness {message.validation.score}/100 ·{" "}
              {message.validation.findings} finding{message.validation.findings === 1 ? "" : "s"}
              {message.validation.topFinding ? ` · ${message.validation.topFinding}` : ""}
            </Badge>
          </div>
        )}

        {onEdit && !message.pending && !editing && (
          <button className="mt-1 flex items-center gap-1 font-mono text-[9px] text-muted-foreground hover:text-foreground" onClick={() => { setDraft(message.content); setEditing(true); }}>
            <Pencil className="h-2.5 w-2.5" />Edit payload
          </button>
        )}

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
