# Architecture

Software Factory is a local-first Next.js application. It has three layers:

| Layer | Location | Responsibility |
| --- | --- | --- |
| UI | `src/app/**/page.tsx`, `src/components/**` | Client components (Home, Projects, Runs, Chat, Agents, Settings), React Flow canvas |
| API | `src/app/api/**/route.ts` | Thin route handlers: validate input, call `src/lib`, stream events |
| Domain | `src/lib/**` | Framework-free logic: orchestration, providers, mesh, persistence, runtime |

Domain modules never import from `app/` or `components/`. API routes own HTTP concerns; the
domain layer only receives plain values.

## Directory map

```
src/lib/
  core/
    types.ts        Shared domain types (Agent, Project, Run, ModelInfo, …)
    constants.ts    Phase definitions, default agents/settings, SDLC metadata
    api.ts          JSON/SSE response helpers, mention parsing, request parsing
    utils.ts        cn(), ids, formatting, small pure helpers
    events.ts       In-process run event stream used by the SSE routes
    env-sync.ts     Scoped .env.local synchronization for provider settings

  data/
    db.ts           JSON persistence under .data/ (factory.json, mesh state)
    store.ts        Zustand client store (useFactory) for runs, agents, models
    workspace.ts    Sandboxed workspace IO; resolveInside rejects path escapes
    desktop.ts      Finder shortcut creation for project workspaces

  providers/
    catalog.ts      Live model discovery (Ollama, LM Studio, OpenCode, cloud keys)
    ollama.ts       Native Ollama streaming adapter
    opencode.ts     OpenCode CLI worker adapter
    universal-provider.ts  One executeLLMCall() contract for every backend
    router.ts       Per-agent routing, metrics, VRAM-aware queue integration

  pipeline/
    engine/         Five-phase SDLC engine
      shared.ts       Active runs, phase state mutation, logging, guardrail hook
      generation.ts   File generation, dependency handshake, verification, commits
      phases/         implementation.ts, testing.ts, deployment.ts
      run.ts          executeRun plus start/cancel/resume/rerun entry points
      index.ts        Public engine API
    guardrails.ts   Deterministic handoff scoring and dead-loop detection
    scheduler.ts    DAG execution for the canvas topology
    topology.ts     Pure topology defaults and cycle validation (browser-safe)
    prompts.ts      Prompt builders for every phase
    parse.ts        Fenced file-block parsing, apply/summary helpers
    decomposer.ts   Task decomposition
    repair-engine.ts Self-heal loop driver
    smart-engine.ts / github-bot.ts  Optional higher-level run strategies

  mesh/
    event-bus.ts    Mesh event stream, agent envelopes, status broadcasting
    validators.ts   Silent Witness: static checks, runtime verification
    negotiation.ts / negotiator.ts  Peer reconciliation loop
    accountability.ts Task contracts and acceptance
    agent-memory.ts / vector-memory.ts / context-manager.ts  Learned constraints
    analytics.ts    Contribution metrics
    controls.ts     Pause/override controls
    shared-cache.ts / skills.ts / router.ts
    tools/          Mesh-local tool registry

  chat/
    turn-engine.ts  Chat turn execution, @mention routing, autonomous handoffs

  runtime/
    sandbox.ts      Allowlisted command execution and health probes
    docker-sandbox.ts Docker-backed sandbox variant
    queue/resource-manager.ts  VRAM/concurrency budget for local models
    system/         Hardware profiler, storage cleaner
    tools/          terminal.ts, toolchain.ts, git.ts, github.ts, workflow.ts
```

## Request flow

1. A page calls a route under `src/app/api/` (for example `POST /api/runs`).
2. The route validates the body with helpers from `core/api.ts`.
3. Domain code runs: `pipeline/engine` orchestrates phases, `providers/router` selects a
   model, `runtime/*` executes commands, `data/workspace` writes files, `data/db` persists state.
4. Progress is published to `core/events.ts`; `api/runs/[id]/events` streams it to the client
   as SSE and `data/store.ts` updates the UI.

## Conventions

- **Imports:** use the `@/` alias everywhere (`@/lib/core/types`, `@/components/ui/button`).
  Relative imports are only used inside a single component folder when the target is a sibling.
- **Server vs client:** `data/db.ts`, `runtime/*`, `providers/*` and `pipeline/*` are server-only.
  Browser-safe modules are `core/utils.ts`, `core/types.ts`, `core/constants.ts`,
  `pipeline/topology.ts` and `data/store.ts`.
- **Persistence:** all local state lives under `.data/` (gitignored). Project files live in
  `.data/workspaces/<project-id>/` and are only written through `workspace.ts`.
- **Safety:** commands go through `runtime/tools/terminal.ts` (allowlist, sanitized env, timeout);
  file writes go through `resolveInside`. Do not bypass either.
- **Engine edits:** phase logic lives in `pipeline/engine/phases/`. Shared state and logging live in
  `pipeline/engine/shared.ts`; keep the public surface in `engine/index.ts` stable.

## Verification

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # next build
```

`AGENTS.md` documents the GitNexus impact-analysis workflow required before editing symbols.
