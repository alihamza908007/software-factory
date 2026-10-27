import type { Agent } from "../types";
import { routeTask } from "../mesh/accountability";

export interface DecomposedTask {
  id: string;
  targetAgent: `@${string}`;
  objective: string;
  dependsOn: string[];
  track: "requirements" | "architecture" | "implementation" | "validation";
}

/** Deterministic, validated task plan. It uses the live roster and never trusts model-generated handles. */
export function decomposeProjectTask(prompt: string, agents: Agent[]): DecomposedTask[] {
  const active = agents.filter((agent) => agent.enabled);
  const pick = (objective: string, preferred?: Agent) => {
    const result = routeTask(active, objective, preferred);
    const agent = result.agent ?? preferred ?? active[0];
    if (!agent) throw new Error("Cannot decompose project work without an enabled agent.");
    return `@${agent.handle.replace(/^@/, "")}` as const;
  };
  const byRole = (expression: RegExp) => active.find((agent) => expression.test(`${agent.name} ${agent.role} ${agent.handle}`));
  const requirements = byRole(/product|requirement|manager/i);
  const architect = byRole(/architect|design/i);
  const developer = byRole(/developer|engineer|implement/i);
  const qa = byRole(/qa|test|quality/i);
  const tasks: DecomposedTask[] = [
    { id: "task-requirements", targetAgent: pick(`Product requirements and acceptance criteria: ${prompt}`, requirements), objective: `Derive testable requirements and acceptance criteria from: ${prompt}`, dependsOn: [], track: "requirements" },
    { id: "task-architecture", targetAgent: pick(`Architecture design and implementation plan: ${prompt}`, architect), objective: "Define architecture, interfaces, file ownership and a runtime verification plan.", dependsOn: ["task-requirements"], track: "architecture" },
  ];
  const mixed = /front.?end|user interface|\bui\b|react|page|dashboard/i.test(prompt) && /back.?end|\bapi\b|database|prisma|server/i.test(prompt);
  if (mixed) {
    tasks.push(
      { id: "task-implementation-ui", targetAgent: pick(`Frontend UI React implementation: ${prompt}`), objective: "Implement the frontend UI track using the architecture contract and owned file paths.", dependsOn: ["task-architecture"], track: "implementation" },
      { id: "task-implementation-api", targetAgent: pick(`Backend API database implementation: ${prompt}`), objective: "Implement the backend API and data track using the architecture contract and owned file paths.", dependsOn: ["task-architecture"], track: "implementation" },
    );
  } else {
    tasks.push({ id: "task-implementation", targetAgent: pick(`Implementation engineering: ${prompt}`, developer), objective: "Implement the approved requirements and architecture.", dependsOn: ["task-architecture"], track: "implementation" });
  }
  tasks.push({ id: "task-validation", targetAgent: pick("QA testing runtime validation tests build", qa), objective: "Run project build, tests and applicable schema/runtime checks; report exact proof.", dependsOn: tasks.filter((task) => task.track === "implementation").map((task) => task.id), track: "validation" });
  return tasks;
}
