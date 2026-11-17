"use client";

import Link from "next/link";
import { ArrowRight, Boxes, MessagesSquare, Plus } from "lucide-react";
import { useFactory } from "@/lib/data/store";
import { timeAgo, truncate } from "@/lib/core/utils";
import { launchRunDialog } from "@/components/shared/run-launcher";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionLabel } from "@/components/shared/page-header";
import { StatusPill } from "@/components/shared/status";
import { EmptyState } from "@/components/shared/empty-state";

export default function HomePage() {
  const { runs, projects, agents } = useFactory();

  const activeRuns = runs.filter((run) => run.status === "running" || run.status === "queued");
  const completedRuns = runs.filter((run) => run.status === "passed");
  const enabledAgents = agents.filter((agent) => agent.enabled);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Overview"
        title="Build something today."
        description="Start a new run or pick up where you left off. Your agents handle the spec, code, tests and delivery."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/chat">
                <MessagesSquare className="h-3.5 w-3.5" />
                Chat
              </Link>
            </Button>
            <Button size="sm" onClick={() => launchRunDialog()}>
              <Plus className="h-3.5 w-3.5" />
              New run
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active runs" value={activeRuns.length} hint={`${runs.length} total`} />
        <Stat label="Completed" value={completedRuns.length} hint="Passed all phases" />
        <Stat label="Projects" value={projects.length} hint="Local workspaces" />
        <Stat label="Agents" value={enabledAgents.length} hint={`${agents.length} configured`} />
      </div>

      <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
        <section className="min-w-0">
          <SectionLabel
            action={
              <Link
                href="/pipeline"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                All runs <ArrowRight className="h-3 w-3" />
              </Link>
            }
          >
            Recent runs
          </SectionLabel>

          {runs.length ? (
            <div className="panel divide-y divide-border overflow-hidden">
              {runs.slice(0, 6).map((run) => {
                const phase = run.phases.find((item) => item.id === run.currentPhase);
                return (
                  <Link
                    key={run.id}
                    href={`/pipeline?run=${run.id}`}
                    className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-secondary/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{truncate(run.prompt, 96)}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">{run.projectName}</span>
                        <span aria-hidden>·</span>
                        <span>{phase ? phase.name : `${run.phases.filter((item) => item.status === "passed").length}/5 phases`}</span>
                        <span aria-hidden>·</span>
                        <span>{timeAgo(run.updatedAt)}</span>
                      </div>
                    </div>
                    <StatusPill status={run.status} />
                  </Link>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No runs yet"
              description="Give the factory a brief and it will take the project from spec to pull request."
              action={
                <Button size="sm" onClick={() => launchRunDialog()}>
                  <Plus className="h-3.5 w-3.5" />
                  Start a run
                </Button>
              }
            />
          )}
        </section>

        <section className="min-w-0">
          <SectionLabel
            action={
              <Link
                href="/projects"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                All projects <ArrowRight className="h-3 w-3" />
              </Link>
            }
          >
            Projects
          </SectionLabel>

          {projects.length ? (
            <div className="panel divide-y divide-border overflow-hidden">
              {projects.slice(0, 5).map((project) => (
                <Link
                  key={project.id}
                  href={`/projects?project=${project.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                    <Boxes className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{project.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{project.stack}</div>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No projects yet"
              description="Add a project to give the agents a workspace."
              action={
                <Button size="sm" variant="outline" asChild>
                  <Link href="/projects">Create a project</Link>
                </Button>
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="panel px-4 py-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}
