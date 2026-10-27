import { cn } from "@/lib/utils";
import type { PhaseStatus, RunStatus } from "@/lib/types";

const RUN_STYLES: Record<RunStatus, { label: string; className: string; dot: string }> = {
  queued: { label: "Queued", className: "text-muted-foreground", dot: "bg-muted-foreground" },
  running: { label: "Running", className: "text-factory-lime", dot: "bg-factory-lime animate-pulse" },
  passed: { label: "Passed", className: "text-factory-lime", dot: "bg-factory-lime" },
  failed: { label: "Failed", className: "text-red-300", dot: "bg-factory-red" },
  cancelled: { label: "Cancelled", className: "text-muted-foreground", dot: "bg-muted-foreground" },
  interrupted: { label: "Interrupted", className: "text-factory-amber", dot: "bg-factory-amber" },
  recoverable_paused: { label: "Paused · recoverable", className: "text-factory-amber", dot: "bg-factory-amber" },
};

const PHASE_STYLES: Record<PhaseStatus, { label: string; className: string; dot: string }> = {
  pending: { label: "Pending", className: "text-muted-foreground", dot: "bg-muted-foreground" },
  running: { label: "Running", className: "text-factory-lime", dot: "bg-factory-lime animate-pulse" },
  passed: { label: "Passed", className: "text-factory-lime", dot: "bg-factory-lime" },
  failed: { label: "Failed", className: "text-red-300", dot: "bg-factory-red" },
  skipped: { label: "Skipped", className: "text-factory-amber", dot: "bg-factory-amber" },
};

export function StatusPill({
  status,
  kind = "run",
  className,
}: {
  status: RunStatus | PhaseStatus;
  kind?: "run" | "phase";
  className?: string;
}) {
  const style =
    kind === "run"
      ? RUN_STYLES[status as RunStatus]
      : PHASE_STYLES[status as PhaseStatus];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-current/20 bg-secondary/50 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider",
        style.className,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", style.dot)} />
      {style.label}
    </span>
  );
}

export function OnlineDot({ online, className }: { online?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        online ? "bg-factory-lime shadow-[0_0_6px_hsl(var(--factory-lime)/0.8)]" : "bg-factory-red/70",
        className,
      )}
    />
  );
}
