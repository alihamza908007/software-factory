"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type {
  Agent,
  ChatMessage,
  ChatThread,
  DeadLoopInfo,
  GuardrailResult,
  Run,
  ValidationFinding,
  ValidationReport,
} from "@/lib/types";

export interface ThreadSummary {
  id: string;
  title: string;
  projectId?: string;
  updatedAt: number;
  messageCount: number;
  directMessageCount?: number;
  handoffCount?: number;
  lastMessage?: ChatMessage | null;
  lastDirectMessage?: ChatMessage | null;
}

export interface ChatSendOptions {
  projectId?: string;
  autonomous?: boolean;
}

interface ValidationSummary {
  reportId: string;
  score: number;
  passed: boolean;
  findings: number;
  topFinding?: string;
}

function appendOrReplace(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

function summaryFromReport(report: ValidationReport): ValidationSummary {
  const actionable = report.findings.filter((finding) => finding.severity !== "info");
  return {
    reportId: report.id,
    score: report.score,
    passed: report.passed,
    findings: actionable.length,
    topFinding: actionable[0]?.title,
  };
}

/**
 * One SSE chat engine shared by the full Chat page and the Mesh Hub matrix.
 * Keeping the transport, message reconciliation and artifact/validation
 * handling here prevents the two surfaces from drifting apart.
 */
export function useChatSession() {
  const { agents, settings, fetchRuns } = useFactory();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [handoff, setHandoff] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const sessionTokens = useMemo(
    () =>
      messages.reduce(
        (sum, message) =>
          message.handoffFrom
            ? sum
            : sum + (message.metrics?.inputTokens ?? 0) + (message.metrics?.outputTokens ?? 0),
        0,
      ),
    [messages],
  );

  function patchMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    );
  }

  async function loadThreads(openLatest = false) {
    try {
      const res = await fetch("/api/threads", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { threads: ThreadSummary[] };
      if (!mountedRef.current) return;
      setThreads(data.threads);
      if (openLatest && data.threads[0]) {
        await openThread(data.threads[0].id);
      }
    } catch {
      // Thread history is non-critical for the chat surface.
    }
  }

  async function openThread(id: string) {
    if (streaming) return;
    try {
      const res = await fetch(`/api/threads/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Thread not found.");
      const data = (await res.json()) as { thread: ChatThread };
      if (!mountedRef.current) return;
      setThreadId(id);
      setMessages(data.thread.messages);
      setHandoff(null);
    } catch (error) {
      toast.error(String(error));
    }
  }

  function newThread() {
    if (streaming) return;
    setThreadId(null);
    setMessages([]);
    setHandoff(null);
  }

  async function deleteThread(id: string) {
    if (streaming) return;
    try {
      const res = await fetch(`/api/threads/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not delete the thread.");
      setThreads((current) => current.filter((thread) => thread.id !== id));
      if (threadId === id) newThread();
    } catch (error) {
      toast.error(String(error));
    }
  }

  function handleSseEvent(event: string, payload: unknown) {
    if (event === "thread") {
      const data = payload as { threadId: string };
      setThreadId(data.threadId);
      return;
    }
    if (event === "message") {
      const message = payload as ChatMessage;
      setMessages((current) => appendOrReplace(current, message));
      return;
    }
    if (event === "agent") {
      const data = payload as {
        status: string;
        agent: Agent;
        messageId: string;
        detail?: string;
        handoffFrom?: string;
        handoffScore?: number;
      };
      if (data.status === "start") {
        setMessages((current) => {
          if (current.some((message) => message.id === data.messageId)) return current;
          return [
            ...current,
            {
              id: data.messageId,
              role: "assistant",
              content: "",
              agentId: data.agent.id,
              agentName: data.agent.name,
              agentColor: data.agent.color,
              handoffFrom: data.handoffFrom,
              handoffScore: data.handoffScore,
              pending: true,
              createdAt: Date.now(),
            },
          ];
        });
      } else if (data.status === "fallback" || data.status === "retry") {
        toast.message(data.detail ?? "Routing adjusted", { description: data.agent.name });
      }
      return;
    }
    if (event === "token") {
      const data = payload as { messageId: string; delta?: string; text?: string };
      if (typeof data.text === "string") {
        patchMessage(data.messageId, { content: data.text, pending: true });
      } else if (data.delta) {
        setMessages((current) =>
          current.map((message) =>
            message.id === data.messageId
              ? { ...message, content: message.content + data.delta, pending: true }
              : message,
          ),
        );
      }
      return;
    }
    if (event === "metrics") {
      const data = payload as {
        messageId: string;
        metrics: NonNullable<ChatMessage["metrics"]>;
      };
      patchMessage(data.messageId, { metrics: data.metrics, pending: false });
      return;
    }
    if (event === "artifact") {
      const data = payload as {
        messageId: string;
        files: string[];
        written: string[];
        errors?: Array<{ path: string; error: string }>;
      };
      const paths = data.written?.length ? data.written : data.files;
      if (data.messageId) patchMessage(data.messageId, { artifacts: paths });
      if (data.errors?.length) {
        toast.warning("Some artifacts were not written", {
          description: data.errors[0]?.error,
        });
      } else if (data.written?.length) {
        toast.success(`${data.written.length} artifact(s) written to the workspace`);
      }
      return;
    }
    if (event === "validation") {
      const data = payload as {
        messageId?: string;
        report: ValidationReport;
        summary?: ValidationSummary;
      };
      const summary = data.summary ?? summaryFromReport(data.report);
      if (data.messageId) patchMessage(data.messageId, { validation: summary });
      // Only toast on validation failure or security finding to avoid toast clutter
      if (!data.report.passed) {
        const actionable = data.report.findings.filter(
          (finding: ValidationFinding) => finding.severity !== "info",
        );
        toast.warning(
          `Validation Notice · ${data.report.score}/100`,
          {
            description:
              actionable[0]?.title ??
              `${data.report.findings.length} finding(s) across published artifacts.`,
          },
        );
      }
      return;
    }
    if (event === "handoff") {
      const data = payload as {
        from: string;
        to: string;
        handle: string;
        reason: string;
        guardrail?: GuardrailResult;
      };
      setHandoff(`${data.from} → ${data.to}`);
      setMessages((current) => [
        ...current,
        {
          id: `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "system",
          content: `**${data.from}** handed off to **${data.to}** (@${data.handle}). ${data.reason}.`,
          handoffFrom: data.from,
          handoffScore: data.guardrail?.score,
          createdAt: Date.now(),
        },
      ]);
      return;
    }
    if (event === "routing") {
      const data = payload as { from: string; to: string; reason: string };
      setMessages((current) => [
        ...current,
        {
          id: `routing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "system",
          content: `**${data.from} → ${data.to}** · ${data.reason}`,
          createdAt: Date.now(),
        },
      ]);
      return;
    }
    if (event === "guardrail") {
      const data = payload as { result: GuardrailResult };
      // Only toast if guardrail failed to alert the user without spamming passed scores
      if (!data.result.passed) {
        toast.warning(
          `Guardrail Retry (${data.result.score}/100)`,
          {
            description:
              data.result.errors[0] ??
              `${data.result.sourceAgent} → ${data.result.targetAgent}`,
          },
        );
      }
      return;
    }
    if (event === "dead_loop") {
      const data = payload as { result?: GuardrailResult; deadLoop?: DeadLoopInfo };
      const info = data.deadLoop ?? data.result?.deadLoop;
      setHandoff("Pipeline frozen");
      toast.error("Dead loop detected", {
        description: info?.message ?? "Pipeline frozen for user review.",
      });
      setMessages((current) => [
        ...current,
        {
          id: `dead-loop-${Date.now()}`,
          role: "system",
          content: `**Dead loop detected — pipeline frozen.** ${info?.message ?? ""}`,
          createdAt: Date.now(),
          error: true,
        },
      ]);
      return;
    }
    if (event === "run") {
      const { run } = payload as { run: Run };
      void fetchRuns();
      toast.success("Pipeline launched", {
        description: "Watch the agents in the Pipeline view.",
      });
      return;
    }
    if (event === "error") {
      const data = payload as { message: string; messageId?: string };
      if (data.messageId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === data.messageId
              ? {
                  ...message,
                  pending: false,
                  error: true,
                  content: message.content || data.message,
                }
              : message,
          ),
        );
      }
      toast.error(data.message);
    }
  }

  async function send(messageOverride: string, sendOptions: ChatSendOptions = {}) {
    const message = messageOverride.trim();
    if (!message || streaming) return false;
    setStreaming(true);
    setHandoff(null);
    const controller = new AbortController();
    abortRef.current = controller;
    let activeThreadId = threadId;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          threadId,
          projectId: sendOptions.projectId || undefined,
          message,
          autonomous: sendOptions.autonomous ?? false,
          autoHandoff: settings?.autoHandoff ?? true,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: "Chat request failed." }));
        throw new Error(data.error ?? "Chat request failed.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const lines = frame.split("\n");
          const eventLine = lines.find((line) => line.startsWith("event:"));
          const dataLines = lines.filter((line) => line.startsWith("data:"));
          if (!eventLine || !dataLines.length) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(dataLines.map((line) => line.slice(5).trim()).join("\n"));
          } catch {
            continue;
          }
          const eventName = eventLine.slice(6).trim();
          if (eventName === "thread") {
            activeThreadId = (payload as { threadId: string }).threadId;
          }
          handleSseEvent(eventName, payload);
        }
      }
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        toast.message("Generation stopped.");
      } else {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (!mountedRef.current) return;
      setStreaming(false);
      abortRef.current = null;
      await loadThreads();
      if (activeThreadId) {
        const res = await fetch(`/api/threads/${activeThreadId}`, { cache: "no-store" }).catch(
          () => null,
        );
        if (res?.ok) {
          const data = (await res.json()) as { thread: ChatThread };
          if (mountedRef.current) setMessages(data.thread.messages);
        }
      }
    }
  }

  async function saveEditedMessage(message: ChatMessage, content: string) {
    if (!threadId) throw new Error("Save this conversation before editing a message.");
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: message.id, content }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not save the edited payload.");
    patchMessage(message.id, { content, error: false });
    toast.success("Edited payload saved");
  }

  async function continueFromEditedMessage(message: ChatMessage, content: string) {
    const agent = agents.find((item) => item.id === message.agentId);
    const continuation = `${agent ? `@${agent.handle} ` : ""}Continue from this corrected payload. Treat it as the latest handoff, verify consistency, and produce the next concrete result:\n\n${content}`;
    await send(continuation);
  }

  function stop() {
    abortRef.current?.abort();
  }

  return {
    threads,
    threadId,
    messages,
    streaming,
    handoff,
    sessionTokens,
    loadThreads,
    openThread,
    newThread,
    deleteThread,
    send,
    stop,
    saveEditedMessage,
    continueFromEditedMessage,
    setThreadId,
    setMessages,
    patchMessage,
  };
}
