/**
 * Typed domain errors that API routes translate into specific HTTP statuses.
 * `code` is checked in addition to `instanceof` because Next.js can evaluate
 * the same module in more than one module graph during development.
 */
export class ProjectBusyError extends Error {
  readonly code = "PROJECT_BUSY";

  constructor(message: string) {
    super(message);
    this.name = "ProjectBusyError";
  }
}

export function isProjectBusy(error: unknown): error is ProjectBusyError {
  return (
    error instanceof ProjectBusyError ||
    (typeof error === "object" && error !== null && (error as { code?: string }).code === "PROJECT_BUSY")
  );
}
