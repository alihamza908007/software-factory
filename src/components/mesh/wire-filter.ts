import type { MeshEvent } from "@/lib/core/types";

export type WireFilter = "useful" | "all" | "alerts" | "validation" | "automation" | "handoff";

export const WIRE_TYPES = new Set<MeshEvent["type"]>([
  "VALIDATION_STARTED",
  "VALIDATION_PASSED",
  "VALIDATION_FAILED",
  "SECURITY_WARNING",
  "VALIDATION_OVERRIDDEN",
  "NEGOTIATION_STARTED",
  "NEGOTIATION_MESSAGE",
  "NEGOTIATION_RESOLVED",
  "NEGOTIATION_FAILED",
  "MEMORY_CONSTRAINT",
  "HANDOFF",
  "AGENT_ENVELOPE",
  "TASK_CONTRACT",
  "PRE_FLIGHT_BLOCKED",
  "POST_FLIGHT_PASSED",
  "POST_FLIGHT_BLOCKED",
  "SCOPE_ADVISORY",
  "ROUTING_ERROR",
  "TEST_FAILED",
  "ARTIFACT_CREATED",
  "TERMINAL_OUTPUT",
  "AUTOMATION_STARTED",
  "AUTOMATION_PASSED",
  "AUTOMATION_FAILED",
  "CANVAS_RUN_STARTED",
  "CANVAS_RUN_COMPLETED",
]);

const NOISE_WIRE_TYPES = new Set<MeshEvent["type"]>([
  "VALIDATION_STARTED",
  "AGENT_STATUS",
  "SCHEMA_UPDATED",
  "AUTOMATION_STARTED",
  "CANVAS_RUN_STARTED",
  "NEGOTIATION_MESSAGE",
  "TERMINAL_OUTPUT",
]);

export function eventMatchesFilter(event: MeshEvent, filter: WireFilter): boolean {
  if (filter === "useful") return !NOISE_WIRE_TYPES.has(event.type);
  if (filter === "all") return true;
  if (filter === "alerts") return event.severity === "error" || Boolean(event.requiresOverride);
  if (filter === "validation") return event.type.startsWith("VALIDATION") || event.type === "SECURITY_WARNING";
  if (filter === "automation") return event.type.startsWith("AUTOMATION") || event.type.startsWith("CANVAS_RUN");
  return event.type === "HANDOFF" || event.type === "AGENT_ENVELOPE" || event.type === "TASK_CONTRACT";
}
