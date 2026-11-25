# Software Factory

A local-first, autonomous **AI Software Factory** for Apple Silicon. Give it a project and a brief; a team of specialised agents runs a five-phase SDLC pipeline — spec, architecture, implementation, testing with self-healing, and deployment/CI — writing real files into a sandboxed workspace on your machine.

Everything runs locally. Cloud models are optional and only used as routing target or fallback; no project data leaves the machine unless you enable GitHub push.

---

## Highlights

- **Agents** — create agents with a name, role and system prompt; assign any local or cloud model; switch a model mid-session; inspect per-agent performance (TTFT, total time, tok/s, tokens, cost, VRAM).
- **Chat** — one master thread, route messages with `@handle`, and let agents hand work off to each other autonomously.
- **5-phase SDLC engine** — Requirements → Architecture → Implementation → Test/Lint/Self-heal → Deployment/CI.
- **Self-healing loop** — the toolchain runs locally, failures are scraped and piped back to the developer agent, and the loop repeats until the suite passes or the heal budget is exhausted.
- **Git automation** — a feature branch per run, semantic commits per phase, and a generated `.github/workflows/main.yml`. With a GitHub token configured it pushes the branch and drafts a pull request with an agent-written summary.
- **VRAM guardrails** — heavy local models are serialised (one generating at a time by default) with a queue, timeout and graceful fallback to lighter local or cloud models tuned for a 48 GB M4 Pro.
- **Universal provider layer** — one `executeLLMCall()` abstraction for Ollama, LM Studio, OpenCode, OpenRouter, Anthropic, OpenAI and Google Gemini, with streaming, token accounting and JSON-schema mode.
- **Supervisor guardrails** — every agent-to-agent handoff is scored 0–100, failed payloads are sent back to the source agent for up to two corrective retries, and identical transitions are frozen with `DEAD_LOOP_EXCEPTION`.
- **Parallel canvas DAG** — drag agent, validator and router nodes in the pipeline canvas, connect pass/fail branches, validate the graph, and run independent branches with `Promise.all()` while cloud calls stay unlimited and local models pass through the VRAM queue.

## Requirements

- macOS on Apple Silicon (targeted at MacBook Pro M4 Pro, 48 GB unified memory).
- Node.js 20+ (built and verified on Node 25).
- [Ollama](https://ollama.com) running locally at `http://localhost:11434` with at least one model pulled.
- [OpenCode](https://opencode.ai) CLI installed and signed in, for cloud models.
- Optional: [LM Studio](https://lmstudio.ai) exposing an OpenAI-compatible server at `http://localhost:1234/v1`.
- Optional: OpenRouter, Anthropic, OpenAI or Google Gemini API keys, configured in **Settings → Universal provider API keys**.

```bash
ollama pull qwen3.8:27b-mlx     # heavy local "developer" model
ollama pull gpt-oss:20b         # light local model
opencode auth login             # enables the free cloud tier via the OpenCode CLI
```

## Local trust model

The server is local-first: `npm run dev` and `npm start` bind to `127.0.0.1` and all state lives under `.data/` (agents, projects, runs, workspaces).

- **Optional API token.** By default the HTTP API is not authenticated: anything able to reach the server can read or write project files, launch runs, and change settings. Keep it on localhost or firewall it. To add a token, set `FACTORY_AUTH_TOKEN` before starting the server, open `http://127.0.0.1:3000/?token=<token>` once (it sets an HttpOnly cookie), or send `Authorization: Bearer <token>` / `x-factory-token` on API calls. Page loads without a valid token go through `/unlock`.
- **Cross-site mutations are blocked.** Mutating API calls with an `Origin` that differs from the request host (or a `Sec-Fetch-Site: cross-site` marker) are rejected with 403, so a random website cannot drive the factory from your browser.
- **Data leaves the machine only when you turn it on.** Cloud models may be used as routing targets or fallbacks, and the optional GitHub integration can push branches and open PRs.

## Getting started

```bash
npm install
npm run dev
# open http://localhost:3000
```

Production build:

```bash
npm run build && npm start
```

> The factory stores state in `.data/factory.json` and project workspaces in `.data/workspaces/`. Each new project also gets a symlink shortcut in `~/Desktop/Software Factory` for quick Finder access; the shortcut is safe to delete without affecting the project. Both `.data/` and the shortcut base folder are local-only.

## Using it

1. Open **Settings** and confirm the providers are online. Models are discovered live from Ollama, LM Studio and OpenCode; cloud keys unlock OpenRouter, Anthropic, OpenAI and Gemini models.
2. Open **Projects**, create a project (name, brief, stack: `node`, `next` or `python`). A scaffold and a git repo are created in the sandbox, and a shortcut to the project appears in **`~/Desktop/Software Factory`**.
3. Click **New run** and paste a build brief. The engine executes all five phases and streams logs, commands and self-heal attempts to the **Runs** view.
4. Open **Runs → Canvas** to design a custom DAG. Agent nodes call the assigned model, validator nodes run local assertions, router nodes choose `pass`/`fail` branches, and **Run DAG** streams live node status without blocking other branches.
5. Use **Chat** to talk to agents (`@morgan`, `@ada`, `@lin`, `@vera`, `@deacon`), or launch an autonomous run straight from chat. Every agent mentioned by another agent receives its own validated handoff.
6. Use **Agents** to tune models, prompts and temperatures, and to watch per-agent metrics.

### Default crew

| Handle | Agent | Role | Default model |
| --- | --- | --- | --- |
| `@product` | Morgan | Product Manager | `opencode/deepseek-v4.1-flash-free` |
| `@architect` | Ada | Systems Architect | `opencode/longcat-2.5-preview-free` |
| `@developer` | Lin | Developer | `ollama/qwen3.8:27b-mlx` (heavy local) |
| `@qa` | Vera | QA Engineer | `opencode/deepseek-v4.1-flash-free` |
| `@devops` | Deacon | DevOps | `opencode/glm-5.3-flash-free` |

Every agent has a fallback model; if a cloud call fails the router retries on the fallback.

### Optional specialists

Eight additional specialists ship with the factory but start disabled: **Sentry** (security audit), **Atlas** (performance), **Quill** (docs), **Cora** (data model), **Iris** (accessibility), **Curator** (dependencies), **Pilot** (release) and **Wren** (test fixtures). Open **Agents** to switch any of them on — the toggle is labelled **In factory** and disables the agent from runs, chat mentions and mesh routing. Use **Enable all** to activate the whole roster or **Core only** to return to the original five. New installs and existing `.data/factory.json` files both receive the specialists on first load.

## Architecture

The app is a Next.js App Router project with a strict split between UI, API routes and a
framework-free domain layer under `src/lib`. A deeper module-by-module guide lives in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/
  app/                     Next.js App Router pages + API routes
    api/                   models, agents, projects, runs (+SSE), chat (+SSE), canvas, threads, settings, providers, resources, health
  components/
    canvas/                React Flow agent, validator and router nodes + DAG editor
    pipeline/              Run board widgets (phase column, log stream, artifact row)
    ...
  lib/
    core/                  cross-cutting primitives: types, constants, api/SSE helpers, utils
    data/                  persistence and sandboxed IO: db.ts, store.ts, workspace.ts
    providers/             catalog.ts (discovery), ollama.ts, opencode.ts, router.ts, universal-provider.ts
    pipeline/              SDLC engine (engine/), guardrails, scheduler, prompts, parse, repair
    mesh/                  event bus, validators, negotiation, memory, analytics, tools
    chat/                  turn-engine.ts (chat routing and handoffs)
    runtime/               sandbox execution, VRAM queue, toolchain + git/github/workflow tools
```

### Model routing

- **Ollama** models are served over the native streaming `/api/chat` endpoint; token counts, TTFT and tok/s are captured server-side.
- **LM Studio / OpenAI / OpenRouter** use the OpenAI-compatible `/v1/chat/completions` streaming API. **Anthropic** uses `/v1/messages` SSE and **Gemini** uses `streamGenerateContent` SSE.
- **OpenCode cloud** models are free-tier and only usable from inside OpenCode, so the adapter runs `opencode run --agent plan --format json` in a scratch directory, parses the JSON event stream, and enforces a text-only contract (no tools). Cloud models use the provider's sampling defaults; `temperature` and `maxTokens` apply to local calls. See the note in *Troubleshooting*.
- The **Resource Manager** treats cloud models as zero-VRAM. Heavy local models are queued (default `maxConcurrentHeavy: 1`); light local models may run up to `maxConcurrentLight` streams (default 2).
- **Guardrails** use a deterministic local classifier (no extra model call). Handoffs below the configured threshold are repaired by the source agent up to `guardrailMaxRetries` times. The supervisor hashes the last `deadLoopWindow` transitions and freezes on `deadLoopThreshold` identical `[source → target + payload]` handoffs.

### Agent output contract

Agents emit complete files as fenced blocks whose info string carries the workspace-relative path:

````
```js path=src/greet.js
export function greet(name) {
  return name ? `Hello, ${name}!` : "Hello, world!";
}
```
````

The parser writes them through `resolveInside`, which blocks `..`, `.env*`, `.git`, `node_modules` and absolute-path escapes.

### Safety boundaries

- Commands run only from an allowlist (`npm`, `npx`, `node`, `python3`, `python`, `pytest`, `git`, `ls`, `cat`, `echo`) with a sanitised environment, `HOME` pinned to the workspace, and a hard timeout.
- **Settings → Allow local command execution** turns toolchain execution off entirely (static-generation mode): install, lint, test and build steps are skipped.
- Cloud agents run in a scratch directory with no project config, so a misbehaving model cannot touch your project tree.

## Configuration

All persisted in `.data/factory.json` and editable in the UI:

- Ollama / LM Studio / OpenCode URLs and OpenCode password (auto-read from `~/.config/opencode/service.json` when blank).
- OpenRouter, Anthropic, OpenAI and Gemini API keys. Changed values are mirrored into `.env.local` with mode `600`; untouched lines in that file are preserved.
- VRAM budget, reserve, heavy/light concurrency limits, queue timeout, fallback model.
- Guardrail threshold, corrective retries, dead-loop trace window and freeze threshold.
- Heal attempts, command timeout, execution and auto-commit toggles.
- Git author identity and GitHub token / owner / repo / base branch.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Cloud models fall back to local | Ensure `opencode auth login` is done and `opencode service status` reports a URL. Free-tier cloud models must go through the CLI worker. |
| `Could not launch the OpenCode CLI` | Install OpenCode and make sure `opencode` is on `PATH`. |
| Ollama models missing | Start Ollama and confirm `curl http://localhost:11434/api/tags`. |
| Pipeline stalls on a heavy model | Lower `maxConcurrentHeavy`, or set the agent's model to a cloud/light model in **Agents**. |
| Tests never converge | Raise `maxHealAttempts`, or check the failure digest in the run's Testing phase. |

## Scripts

```bash
npm run dev        # development server
npm run build      # production build
npm start          # serve the production build
npm run typecheck  # tsc --noEmit
```
