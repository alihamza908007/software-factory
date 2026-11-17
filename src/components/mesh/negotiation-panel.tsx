"use client";

import { useEffect, useState } from "react";
import { GitMerge, Loader2, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/data/store";
import type { Agent } from "@/lib/core/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface NegotiationSummary {
  id: string;
  status: "running" | "resolved" | "failed";
  request: { topic: string; leftAgentId: string; rightAgentId: string; autoApply?: boolean };
  rounds: number;
  agreement?: string;
  appliedFiles: string[];
  error?: string;
  messages?: Array<{ id: string; round: number; fromAgent: string; content: string }>;
  startedAt: number;
  completedAt?: number;
}

export function NegotiationPanel({ agents }: { agents: Agent[] }) {
  const { projects } = useFactory();
  const [leftAgentId, setLeftAgentId] = useState(agents[0]?.id ?? "");
  const [rightAgentId, setRightAgentId] = useState(agents[1]?.id ?? "");
  const [topic, setTopic] = useState("Reconcile the frontend/backend contract and component props.");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [autoApply, setAutoApply] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [history, setHistory] = useState<NegotiationSummary[]>([]);

  async function refreshHistory() {
    try {
      const res = await fetch("/api/mesh/negotiate", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { negotiations: NegotiationSummary[] };
      setHistory(data.negotiations ?? []);
    } catch {
      // Negotiation history is informational.
    }
  }

  useEffect(() => {
    void refreshHistory();
  }, []);

  useEffect(() => {
    if (!history.some((item) => item.status === "running")) return;
    const timer = setInterval(() => void refreshHistory(), 4_000);
    return () => clearInterval(timer);
  }, [history]);

  useEffect(() => {
    if (!leftAgentId && agents[0]) setLeftAgentId(agents[0].id);
    if (!rightAgentId && agents[1]) setRightAgentId(agents[1].id);
  }, [agents, leftAgentId, rightAgentId]);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  async function launch() {
    if (!leftAgentId || !rightAgentId || !topic.trim()) {
      toast.error("Choose two agents and a reconciliation topic.");
      return;
    }
    if (leftAgentId === rightAgentId) {
      toast.error("Choose two different agents.");
      return;
    }
    setLaunching(true);
    try {
      const res = await fetch("/api/mesh/negotiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leftAgentId,
          rightAgentId,
          topic,
          projectId: projectId || undefined,
          autoApply,
          maxRounds: 3,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Negotiation could not start.");
      toast.success("Peer negotiation dispatched", {
        description: `${data.negotiation.id} is running in the background.`,
      });
      await refreshHistory();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section className="panel p-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow flex items-center gap-1.5">
          <GitMerge className="h-3 w-3 text-factory-cyan" />
          Peer negotiation
        </span>
        <Badge variant="outline">background</Badge>
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">
        Two agents reconcile schema or prop conflicts in a bounded loop, then optionally write the
        resolved files.
      </p>
      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
        <Select value={leftAgentId} onValueChange={setLeftAgentId}>
          <SelectTrigger className="h-7 text-[10px]">
            <SelectValue placeholder="Agent A" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={rightAgentId} onValueChange={setRightAgentId}>
          <SelectTrigger className="h-7 text-[10px]">
            <SelectValue placeholder="Agent B" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Input
        value={topic}
        onChange={(event) => setTopic(event.target.value)}
        className="mt-1.5 h-7 text-[10px]"
        placeholder="What should they reconcile?"
      />
      <div className="mt-1.5 grid grid-cols-[1fr_auto] items-center gap-2">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-7 text-[10px]">
            <SelectValue placeholder="Project context" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 font-mono text-[8px] text-muted-foreground">
          apply
          <Switch checked={autoApply} onCheckedChange={setAutoApply} className="h-4 w-7 [&>span]:h-3 [&>span]:w-3" />
        </label>
      </div>
      <Button
        size="sm"
        className="mt-2 w-full"
        onClick={() => void launch()}
        disabled={launching || agents.length < 2}
      >
        {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Waypoints className="h-3 w-3" />}
        Start peer negotiation
      </Button>
      {!!history.length && (
        <div className="mt-2.5 space-y-1.5 border-t border-border/60 pt-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
              Recent negotiations
            </span>
            <button
              className="text-[8px] text-muted-foreground hover:text-foreground"
              onClick={() => void refreshHistory()}
            >
              refresh
            </button>
          </div>
          {history.slice(0, 4).map((item) => (
            <div key={item.id} className="rounded border border-border/60 bg-secondary/50 p-2">
              <div className="flex items-center gap-1.5">
                <Badge
                  variant={
                    item.status === "resolved"
                      ? "success"
                      : item.status === "failed"
                        ? "destructive"
                        : "warning"
                  }
                  className="text-[7px]"
                >
                  {item.status}
                </Badge>
                <span className="ml-auto font-mono text-[7px] text-muted-foreground">
                  {item.rounds} round(s)
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">
                {item.request.topic}
              </p>
              {item.agreement && (
                <p className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-factory-lime/90">
                  {item.agreement}
                </p>
              )}
              {item.error && (
                <p className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-red-300">
                  {item.error}
                </p>
              )}
              {!!item.appliedFiles.length && (
                <p className="mt-1 truncate font-mono text-[7px] text-factory-cyan">
                  wrote {item.appliedFiles.join(", ")}
                </p>
              )}
              {!!item.messages?.length && (
                <details className="mt-1 text-[8px] text-muted-foreground">
                  <summary className="cursor-pointer font-mono">transcript · {item.messages.length} message(s)</summary>
                  <div className="mt-1 max-h-32 space-y-1 overflow-auto rounded bg-secondary/50 p-1.5">
                    {item.messages.map((message) => (
                      <p key={message.id} className="break-words">
                        <span className="font-mono text-factory-cyan">r{message.round} {message.fromAgent}:</span>{" "}
                        {message.content}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
