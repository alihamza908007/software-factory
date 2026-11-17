"use client";

import { useState } from "react";
import { Brain, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/data/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export function MemoryPanel() {
  const { meshMemory, agents, fetchMeshMemory } = useFactory();
  const [clearing, setClearing] = useState(false);

  async function clearMemory() {
    setClearing(true);
    try {
      await fetch("/api/mesh/memory", { method: "DELETE" });
      await fetchMeshMemory();
      toast.success("Epigenetic memory cleared.");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setClearing(false);
    }
  }

  const constraints = meshMemory.flatMap((memory) =>
    memory.constraints.map((constraint) => ({ memory, constraint })),
  );

  return (
    <section className="panel flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
        <span className="eyebrow flex items-center gap-1.5">
          <Brain className="h-3 w-3 text-factory-lime" />
          Epigenetic memory
        </span>
        <div className="flex items-center gap-1">
          <Badge variant="outline">{constraints.length}</Badge>
          <button
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            onClick={() => void fetchMeshMemory()}
            aria-label="Refresh memory"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>
      <ScrollArea className="h-52">
        <div className="space-y-1.5 p-2">
          {constraints.slice().reverse().map(({ memory, constraint }) => {
            const agent = agents.find((item) => item.id === memory.agentId);
            return (
              <div key={constraint.id} className="rounded-md border border-border/60 bg-secondary/50 p-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: agent?.color ?? "#c8f169" }}
                  />
                  <span className="truncate text-[10px] font-medium">{agent?.name ?? memory.agentId}</span>
                  <Badge variant="outline" className="text-[7px]">{constraint.source}</Badge>
                  <span className="ml-auto font-mono text-[7px] text-muted-foreground">
                    ×{constraint.hits}
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-[9px] leading-relaxed text-muted-foreground">
                  {constraint.rule}
                </p>
              </div>
            );
          })}
          {!constraints.length && (
            <p className="px-2 py-6 text-center text-[10px] text-muted-foreground">
              No learned constraints yet. Failures and validator feedback will appear here.
            </p>
          )}
        </div>
      </ScrollArea>
      {!!constraints.length && (
        <div className="border-t border-border/60 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-[10px] text-muted-foreground"
            onClick={() => void clearMemory()}
            disabled={clearing}
          >
            {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Clear learned memory
          </Button>
        </div>
      )}
    </section>
  );
}
