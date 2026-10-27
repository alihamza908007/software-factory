"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, GitPullRequest, Loader2, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Project } from "@/lib/types";

const LAUNCH_EVENT = "factory:launch-run";

export function launchRunDialog(projectId?: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LAUNCH_EVENT, { detail: { projectId } }));
  }
}

export function GlobalRunLauncher() {
  const router = useRouter();
  const { projects, settings, activePipelineTopology, fetchProjects, fetchRuns } = useFactory();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attempts, setAttempts] = useState(3);
  const [push, setPush] = useState(false);
  const [allowConcurrency, setAllowConcurrency] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newStack, setNewStack] = useState<Project["stack"]>("node");

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId) setProjectId(detail.projectId);
      setOpen(true);
    };
    window.addEventListener(LAUNCH_EVENT, listener);
    return () => window.removeEventListener(LAUNCH_EVENT, listener);
  }, []);

  useEffect(() => {
    if (open && !projectId && projects[0]) setProjectId(projects[0].id);
    if (open && settings) setAttempts(settings.maxHealAttempts);
  }, [open, projects, projectId, settings]);

  async function createProject() {
    if (!newName.trim()) {
      toast.error("Give the project a name.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName, description: newName, stack: newStack }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create project.");
      await fetchProjects();
      setProjectId(data.project.id);
      setNewName("");
      toast.success("Workspace scaffolded", { description: data.project.workspacePath });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setCreating(false);
    }
  }

  async function launch() {
    if (!projectId) {
      toast.error("Select or create a project first.");
      return;
    }
    if (prompt.trim().length < 12) {
      toast.error("Describe what you want built (at least a sentence).");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt,
          maxHealAttempts: attempts,
          allowConcurrency,
          pushToGitHub: push,
          pipelineTopology: activePipelineTopology ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not launch run.");
      toast.success("Factory started", {
        description: activePipelineTopology
          ? `Starting the active ${activePipelineTopology.nodes.length}-node SDLC graph.`
          : "Five agents are spinning up the standard SDLC pipeline.",
      });
      setOpen(false);
      setPrompt("");
      await fetchRuns();
      router.push(`/pipeline?run=${data.run.id}`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-factory-lime">
            <Sparkles className="h-3.5 w-3.5" />
            Autonomous SDLC
          </div>
          <DialogTitle>Launch a factory run</DialogTitle>
          <DialogDescription>
            A brief becomes a spec, an architecture, working code, tests and a CI-backed pull
            request. Local models are serialized through the VRAM guard.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Workspace</Label>
            {projects.length ? (
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name} · {project.stack}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                No workspaces yet. Create one below.
              </div>
            )}
          </div>

          {!projects.length && (
            <div className="grid gap-3 rounded-lg border border-border/70 bg-secondary/50 p-3 sm:grid-cols-[1fr_140px_auto]">
              <div className="grid gap-1.5">
                <Label>Project name</Label>
                <Input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="e.g. Inventory API"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Stack</Label>
                <Select value={newStack} onValueChange={(value) => setNewStack(value as Project["stack"])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="node">Node · zero deps</SelectItem>
                    <SelectItem value="python">Python 3</SelectItem>
                    <SelectItem value="next">Next.js</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button variant="secondary" onClick={createProject} disabled={creating}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  Create
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>Build brief</Label>
            {activePipelineTopology && (
              <div className="rounded-md border border-factory-cyan/20 bg-factory-cyan/5 px-2.5 py-1.5 font-mono text-[10px] text-factory-cyan">
                Active canvas blueprint · {activePipelineTopology.nodes.length} nodes · {activePipelineTopology.edges.length} connections
              </div>
            )}
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
              placeholder="Build a dependency-free task API with create, list, complete and delete endpoints, input validation and deterministic tests…"
              className="resize-none"
            />
            <p className="text-[11px] text-muted-foreground">
              The Product Manager expands this into acceptance criteria. The Architect maps the
              files. Development runs locally. QA executes and self-heals.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-secondary/50 px-3 py-2.5">
              <div>
                <div className="text-xs font-medium">Self-heal budget</div>
                <div className="text-[10px] text-muted-foreground">Max repair loops</div>
              </div>
              <Input
                type="number"
                min={0}
                max={8}
                value={attempts}
                onChange={(event) => setAttempts(Number(event.target.value))}
                className="h-8 w-16 text-center font-mono"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-secondary/50 px-3 py-2.5">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <GitPullRequest className="h-3.5 w-3.5 text-factory-cyan" />
                  Push & draft PR
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {settings?.hasGithubToken ? "GitHub configured" : "Token required in Settings"}
                </div>
              </div>
              <Switch checked={push} onCheckedChange={setPush} disabled={!settings?.hasGithubToken} />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-secondary/50 px-3 py-2.5">
              <div>
                <div className="text-xs font-medium">Parallel verification</div>
                <div className="text-[10px] text-muted-foreground">Run lint and tests together</div>
              </div>
              <Switch checked={allowConcurrency} onCheckedChange={setAllowConcurrency} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={launch} disabled={loading || !projectId}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {loading ? "Starting agents…" : "Start pipeline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
