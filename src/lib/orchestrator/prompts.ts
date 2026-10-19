import type { Agent, Project } from "../types";
import type { ProviderMessage } from "../providers/ollama";

function messages(agent: Agent, user: string): ProviderMessage[] {
  return [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: user },
  ];
}

const FILE_FORMAT = `OUTPUT CONTRACT — read carefully:
You are a text-generation worker in a read-only sandbox. You have NO access to the target workspace and you MUST NOT use tools, run commands, read or write files, or ask questions. The only way your work reaches the project is by printing complete fenced file blocks in your reply.

Return every file as a complete fenced block. The info string MUST contain the exact workspace-relative path:

\`\`\`js path=src/example.js
// complete file contents — no placeholders, no ellipses
\`\`\`

Rules:
- Print the file blocks directly in your reply; never describe a plan instead of printing code.
- The file list and code excerpts provided above are informational context only. Do not report that files are missing or refuse because you cannot edit them — simply print the files that should exist.
- Emit only complete files that need to be created or replaced.
- Never emit diffs, patches, or partial snippets.
- Use forward-slash relative paths. Never use absolute paths or "..".
- Do not wrap the whole response in another code fence.
- Do not invent dependencies unless the brief explicitly requires them.`;

export function specPrompt(agent: Agent, project: Project, brief: string): ProviderMessage[] {
  return messages(
    agent,
    `PROJECT: ${project.name}
STACK: ${project.stack}
BRIEF:
${brief}

Produce a precise product specification in Markdown with these sections:
1. Problem & outcome
2. User stories
3. Functional requirements (numbered, testable)
4. Non-functional requirements
5. API / interface contract (if applicable)
6. Acceptance criteria (Given/When/Then, directly testable)
7. Explicit out of scope
8. Assumptions and risks

Keep it implementation-ready and constrained enough to build in one local workspace. Do not include code.`,
  );
}

export function architecturePrompt(
  agent: Agent,
  project: Project,
  brief: string,
  spec: string,
): ProviderMessage[] {
  return messages(
    agent,
    `PROJECT: ${project.name}
STACK: ${project.stack}
BRIEF:
${brief}

SPECIFICATION:
${spec}

Design the architecture in Markdown with:
1. System overview and runtime model
2. Module boundaries and responsibilities
3. Data shapes / interface contracts
4. Error handling and edge cases
5. Security and safety considerations
6. Exact file tree to implement (use a fenced text block)
7. Test strategy mapped to acceptance criteria
8. Implementation order

Do not write implementation code. The file tree must be realistic for the ${project.stack} stack and dependency-light.`,
  );
}

export function implementationPrompt(
  agent: Agent,
  project: Project,
  brief: string,
  spec: string,
  architecture: string,
  existingTree: string,
): ProviderMessage[] {
  const stackRules =
    project.stack === "python"
      ? "Use Python 3 standard library only. Keep the public entry point in main.py. Do not create tests in this phase; QA owns tests."
      : project.stack === "next"
        ? "Use the existing Next.js app structure. Keep dependencies to the ones already declared. Do not create tests in this phase; QA owns tests."
        : "Use modern ESM JavaScript with Node.js built-ins only. Do not add npm dependencies. Do not create or modify tests in this phase; QA owns tests.";
  return messages(
    agent,
    `PROJECT: ${project.name}
STACK: ${project.stack}

BRIEF:
${brief}

SPECIFICATION:
${spec}

ARCHITECTURE:
${architecture}

CURRENT WORKSPACE FILES:
${existingTree || "(scaffold)"}

Implement the project now. ${stackRules}

Every exported function must be importable by the tests. Keep the implementation focused, readable and complete. ${FILE_FORMAT}`,
  );
}

export function testPrompt(
  agent: Agent,
  project: Project,
  brief: string,
  spec: string,
  architecture: string,
  tree: string,
  codeContext: string,
): ProviderMessage[] {
  const testRules =
    project.stack === "python"
      ? "Use Python's built-in unittest (tests/test_*.py). Import the public functions from main.py. No third-party packages."
      : project.stack === "next"
        ? "Use Node's built-in node:test runner in test/*.test.js where practical. Do not add dependencies."
        : "Use Node's built-in node:test and node:assert/strict in test/*.test.js. No third-party packages.";
  return messages(
    agent,
    `PROJECT: ${project.name}
STACK: ${project.stack}

SPECIFICATION:
${spec}

ARCHITECTURE:
${architecture}

WORKSPACE FILES:
${tree}

IMPLEMENTATION:
${codeContext}

Write an adversarial but fair test suite that verifies the acceptance criteria and core edge cases. ${testRules}

Tests must assert the actual public contract. Do not weaken assertions to force a pass. If the implementation is missing a required behaviour, write the failing test — the self-healing loop will fix the implementation.

${FILE_FORMAT}`,
  );
}

export function healPrompt(
  agent: Agent,
  project: Project,
  spec: string,
  failure: string,
  codeContext: string,
  attempt: number,
): ProviderMessage[] {
  return messages(
    agent,
    `PROJECT: ${project.name}
STACK: ${project.stack}
SELF-HEAL ATTEMPT: ${attempt}

SPECIFICATION:
${spec}

CURRENT WORKSPACE CODE:
${codeContext}

RAW LINT / TEST FAILURE OUTPUT:
${failure}

Diagnose the root cause and repair the implementation. Change the smallest correct surface. Do not delete failing tests and do not weaken assertions. If a test is genuinely invalid (it contradicts the specification), fix that test and explain why in one sentence before the file blocks.

Return complete replacement files only. ${FILE_FORMAT}`,
  );
}

export function deployPrompt(
  agent: Agent,
  project: Project,
  brief: string,
  runSummary: string,
): ProviderMessage[] {
  return messages(
    agent,
    `PROJECT: ${project.name}
STACK: ${project.stack}
BRIEF: ${brief}

PIPELINE RESULT:
${runSummary}

Write a concise deployment and operations note in Markdown for docs/DEPLOYMENT.md with:
1. What ships
2. Local verification commands
3. CI pipeline expectations
4. Rollback plan
5. Known risks

Do not include secrets. Keep it under 250 words.`,
  );
}

export function handoffPrompt(
  agent: Agent,
  fromAgent: string,
  originalPrompt: string,
  previousOutput: string,
): ProviderMessage[] {
  return messages(
    agent,
    `AUTONOMOUS HANDOFF from ${fromAgent}.

ORIGINAL USER REQUEST:
${originalPrompt}

${fromAgent.toUpperCase()} OUTPUT:
${previousOutput}

Continue the work from your role. Be concise. If you produce artifacts, use complete fenced files with path= info strings. If nothing remains for your role, state that clearly and stop.`,
  );
}

export function chatPrompt(
  agent: Agent,
  history: Array<{ role: "user" | "assistant"; content: string; agentName?: string }>,
  userMessage: string,
  projectContext?: string,
): ProviderMessage[] {
  const transcript = history
    .slice(-12)
    .map(
      (message) =>
        `${message.agentName ? `${message.agentName} (assistant)` : message.role === "user" ? "USER" : "ASSISTANT"}: ${message.content}`,
    )
    .join("\n\n");
  return messages(
    agent,
    `${projectContext ? `PROJECT CONTEXT:\n${projectContext}\n\n` : ""}${
      transcript ? `CONVERSATION:\n${transcript}\n\n` : ""
    }USER:\n${userMessage}

Respond in your role. Use Markdown. If you need another specialist, mention them exactly as @handle at the end of your response.`,
  );
}
