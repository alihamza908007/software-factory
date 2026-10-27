"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Boxes,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  Folder,
  GitBranch,
  Loader2,
  MonitorSmartphone,
  Plus,
  Rocket,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useFactory } from "@/lib/store";
import type { Project, Run } from "@/lib/types";
import { cn, formatDuration, timeAgo, truncate } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusPill } from "@/components/shared/status";
import { launchRunDialog } from "@/components/shared/run-launcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const STACK_META: Record<Project["stack"], { label: string; color: string }> = {
  node: { label: "Node · zero deps", color: "#c8f169" },
  python: { label: "Python 3", color: "#6fe7dd" },
  next: { label: "Next.js", color: "#f5b544" },
};

export default function ProjectsPage() {
  const { projects, fetchProjects, fetchRuns, runs } = useFactory();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newStack, setNewStack] = useState<Project["stack"]>("node");
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Project | null>(null);
  const [detailRuns, setDetailRuns] = useState<Run[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);

  useEffect(() => {
    void fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () =>
      projects.filter((project) =>
        `${project.name} ${project.description} ${project.stack}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [projects, query],
  );

  async function createProject() {
    if (!newName.trim()) {
      toast.error("Project name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: newName,
          description: newDescription || newName,
          stack: newStack,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create project.");
      await fetchProjects();
      setCreating(false);
      setNewName("");
      setNewDescription("");
      toast.success("Workspace scaffolded", {
        description: data.project.desktopLink
          ? `Desktop shortcut: ${data.project.desktopLink}`
          : data.project.workspacePath,
      });
      void openDetail(data.project);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(project: Project) {
    setDetail(project);
    setLoadingDetail(true);
    setSelectedFile(null);
    setFileContent("");
    try {
      const res = await fetch(`/api/projects/${project.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load project.");
      setFiles(data.files ?? []);
      setDetailRuns(data.runs ?? []);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function loadFile(project: Project, file: string) {
    setSelectedFile(file);
    setFileContent("Loading…");
    try {
      const res = await fetch(
        `/api/projects/${project.id}/files?file=${encodeURIComponent(file)}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read file.");
      setFileContent(data.content);
    } catch (error) {
      setFileContent(String(error));
    }
  }

  async function deleteProject() {
    if (!deleting) return;
    try {
      const res = await fetch(`/api/projects/${deleting.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      await Promise.all([fetchProjects(), fetchRuns()]);
      if (detail?.id === deleting.id) setDetail(null);
      toast.success("Project removed.");
      setDeleting(null);
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Local workspaces"
        title="Projects"
        description="Every project is a real folder under .data/workspaces. Agents write files there, git tracks phase commits, and the local terminal runs its tests."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            New project
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspaces…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
          <span>{projects.length} workspaces</span>
          <span>·</span>
          <span>{runs.length} runs</span>
          <span>·</span>
          <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" /> local git</span>
        </div>
      </div>

      {filtered.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => {
            const stack = STACK_META[project.stack];
            const lastRun = project.lastRun as Run | null | undefined;
            return (
              <section key={project.id} className="panel group relative flex flex-col overflow-hidden p-4">
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 h-px"
                  style={{ background: `linear-gradient(90deg, transparent, ${stack.color}80, transparent)` }}
                />
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/50 text-factory-cyan">
                      <Boxes className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{project.name}</h3>
                      <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: stack.color }}>
                        {stack.label}
                      </div>
                    </div>
                  </div>
                  <Badge variant="outline">{project.runCount ?? 0} runs</Badge>
                </div>

                <p className="mt-3 line-clamp-2 min-h-[32px] text-[11px] leading-relaxed text-muted-foreground">
                  {project.description}
                </p>

                <div className="mt-3 rounded-md border border-border/50 bg-secondary/50 px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground">
                  <div className="truncate">{project.workspacePath}</div>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  {lastRun ? (
                    <>
                      <StatusPill status={lastRun.status} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">
                        {truncate(lastRun.prompt, 46)}
                      </span>
                    </>
                  ) : (
                    <span className="font-mono text-[9px] text-muted-foreground">No runs yet</span>
                  )}
                  <span className="font-mono text-[9px] text-muted-foreground">{timeAgo(project.updatedAt)}</span>
                </div>

                <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-3">
                  <Button variant="secondary" size="sm" className="flex-1" onClick={() => void openDetail(project)}>
                    <Folder className="h-3.5 w-3.5" />
                    Open
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => launchRunDialog(project.id)}>
                    <Rocket className="h-3.5 w-3.5" />
                    Run
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-red-300"
                    onClick={() => setDeleting(project)}
                    aria-label="Delete project"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Boxes className="h-4 w-4" />}
          title="No workspaces yet"
          description="Create a project to scaffold a real folder that the factory can build inside."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              New project
            </Button>
          }
        />
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create a workspace</DialogTitle>
            <DialogDescription>
              A dependency-light scaffold is created immediately. The local model queue and git manager
              operate only inside this folder.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Task API" />
            </div>
            <div className="grid gap-1.5">
              <Label>Description / brief</Label>
              <Textarea
                value={newDescription}
                onChange={(event) => setNewDescription(event.target.value)}
                rows={3}
                placeholder="A dependency-free task API with validation and deterministic tests…"
                className="resize-none"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Stack</Label>
              <Select value={newStack} onValueChange={(value) => setNewStack(value as Project["stack"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">Node · zero dependencies</SelectItem>
                  <SelectItem value="python">Python 3 · unittest</SelectItem>
                  <SelectItem value="next">Next.js · npm</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={createProject} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-hidden">
          {detail && (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{STACK_META[detail.stack].label}</Badge>
                  <span className="font-mono text-[9px] text-muted-foreground">{detail.workspacePath}</span>
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(detail.workspacePath);
                      toast.success("Workspace path copied.");
                    }}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Copy path"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  {detail.desktopLink && (
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(detail.desktopLink as string);
                        toast.success("Desktop shortcut copied.");
                      }}
                      className="inline-flex items-center gap-1 rounded-full border border-factory-lime/25 bg-factory-lime/5 px-2 py-0.5 font-mono text-[9px] text-factory-lime hover:bg-factory-lime/10"
                      title={detail.desktopLink}
                    >
                      <MonitorSmartphone className="h-3 w-3" />
                      Desktop
                    </button>
                  )}
                </div>
                <DialogTitle>{detail.name}</DialogTitle>
                <DialogDescription>{detail.description}</DialogDescription>
              </DialogHeader>

              <Tabs defaultValue="overview" className="min-h-0">
                <div className="flex items-center justify-between">
                  <TabsList>
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="files">Files · {files.length}</TabsTrigger>
                    <TabsTrigger value="runs">Runs · {detailRuns.length}</TabsTrigger>
                  </TabsList>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => launchRunDialog(detail.id)}>
                      <Rocket className="h-3.5 w-3.5" />
                      Launch run
                    </Button>
                  </div>
                </div>

                <TabsContent value="overview">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="panel-inset p-3">
                      <div className="eyebrow">Runs</div>
                      <div className="metric">{detailRuns.length}</div>
                    </div>
                    <div className="panel-inset p-3">
                      <div className="eyebrow">Passed</div>
                      <div className="metric text-factory-lime">{detailRuns.filter((run) => run.status === "passed").length}</div>
                    </div>
                    <div className="panel-inset p-3">
                      <div className="eyebrow">Created</div>
                      <div className="metric text-lg">{timeAgo(detail.createdAt)}</div>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <div className="panel-inset p-3">
                      <SectionLabel>Latest run</SectionLabel>
                      {detailRuns[0] ? (
                        <div>
                          <div className="flex items-center gap-2">
                            <StatusPill status={detailRuns[0].status} />
                            <span className="font-mono text-[9px] text-muted-foreground">{timeAgo(detailRuns[0].updatedAt)}</span>
                          </div>
                          <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{detailRuns[0].prompt}</p>
                          <div className="mt-2 flex items-center gap-2 font-mono text-[9px] text-muted-foreground">
                            <GitBranch className="h-3 w-3" /> {detailRuns[0].git.branch ?? "—"}
                          </div>
                          <Button variant="outline" size="sm" className="mt-3" asChild>
                            <Link href={`/pipeline?run=${detailRuns[0].id}`}>
                              Open trace <ExternalLink className="h-3 w-3" />
                            </Link>
                          </Button>
                        </div>
                      ) : (
                        <div className="py-4 text-xs text-muted-foreground">No runs yet.</div>
                      )}
                    </div>
                    <div className="panel-inset p-3">
                      <SectionLabel>Workspace facts</SectionLabel>
                      <div className="space-y-2 font-mono text-[10px]">
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">Stack</span>
                          <span>{detail.stack}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">Files</span>
                          <span>{files.length}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">Git</span>
                          <span>{detail.gitInitialized ? "initialized" : "on first run"}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">Execution</span>
                          <span>allowlisted · timeout</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="files">
                  <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                    <div className="panel-inset max-h-[46vh] overflow-y-auto p-1.5">
                      {loadingDetail ? (
                        <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading files…
                        </div>
                      ) : (
                        files.map((file) => (
                          <button
                            key={file}
                            onClick={() => void loadFile(detail, file)}
                            className={cn(
                              "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left font-mono text-[10px] transition-colors",
                              selectedFile === file ? "bg-factory-lime/10 text-factory-lime" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                            )}
                          >
                            <FileCode2 className="h-3 w-3 shrink-0" />
                            <span className="truncate">{file}</span>
                          </button>
                        ))
                      )}
                    </div>
                    <div className="panel-inset flex max-h-[46vh] min-h-[300px] flex-col overflow-hidden">
                      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                        <span className="truncate font-mono text-[10px] text-muted-foreground">{selectedFile ?? "Select a file"}</span>
                        {selectedFile && <Badge variant="outline">read-only</Badge>}
                      </div>
                      <pre className="flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[10px] leading-relaxed text-zinc-300">
                        {selectedFile ? fileContent : "Choose a file from the workspace tree."}
                      </pre>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="runs">
                  <div className="panel-inset max-h-[46vh] overflow-y-auto">
                    {detailRuns.map((run) => (
                      <Link
                        key={run.id}
                        href={`/pipeline?run=${run.id}`}
                        className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-0 hover:bg-secondary/50"
                      >
                        <StatusPill status={run.status} />
                        <span className="min-w-0 flex-1 truncate text-[11px]">{run.prompt}</span>
                        <span className="hidden font-mono text-[9px] text-muted-foreground sm:block">
                          {run.phases.filter((phase) => phase.status === "passed").length}/5
                        </span>
                        <span className="font-mono text-[9px] text-muted-foreground">{timeAgo(run.updatedAt)}</span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      </Link>
                    ))}
                    {!detailRuns.length && (
                      <div className="py-10 text-center text-xs text-muted-foreground">No runs for this workspace.</div>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>
              This removes the project record and its run history from the factory. The workspace folder is
              left on disk so you can inspect or archive it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={deleteProject}>
              <Trash2 className="h-4 w-4" />
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
