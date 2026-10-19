# Software Factory

A local-first, autonomous **AI Software Factory** for Apple Silicon. Give it a project and a brief; a team of specialised agents runs a five-phase SDLC pipeline — spec, architecture, implementation, testing with self-healing, and deployment/CI — writing real files into a sandboxed workspace on your machine.

Everything runs locally. Cloud models are optional and only used as routing target or fallback; no project data leaves the machine unless you enable GitHub push.

---

## Highlights

- **Agent Manager** — create agents with a name, role and system prompt; assign any local or cloud model; switch a model mid-session; inspect per-agent performance (TTFT, total time, tok/s, tokens, cost, VRAM).
- **Chat Matrix** — one master chat thread, route messages with `@handle`, and let agents hand work off to each other autonomously.
- **5-phase SDLC engine** — Requirements → Architecture → Implementation → Test/Lint/Self-heal → Deployment/CI.
- **Self-healing loop** — the toolchain runs locally, failures are scraped and piped back to the developer agent, and the loop repeats until the suite passes or the heal budget is exhausted.
- **Git automation** — a feature branch per run, semantic commits per phase, and a generated `.github/workflows/main.yml`. With a GitHub token configured it pushes the branch and drafts a pull request with an agent-written summary.
- **VRAM guardrails** — heavy local models are serialised (one generating at a time by default) with a queue, timeout and graceful fallback to lighter local or cloud models tuned for a 48 GB M4 Pro.

## Requirements

- macOS on Apple Silicon (targeted at MacBook Pro M4 Pro, 48 GB unified memory).
- Node.js 20+ (built and verified on Node 25).
- [Ollama](https://ollama.com) running locally at `http://localhost:11434` with at least one model pulled.
- [OpenCode](https://opencode.ai) CLI installed and signed in, for cloud models.

```bash
ollama pull qwen3.8:27b-mlx     # heavy local "developer" model
ollama pull gpt-oss:20b         # light local model
opencode auth login             # enables the free cloud tier via the OpenCode CLI
```

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

> The factory stores state in `.data/factory.json` and project workspaces in `.data/workspaces/`. Both are git-ignored.

## Using it

1. Open **Settings** and confirm the providers are online. Models are discovered live from Ollama and OpenCode.
2. Open **Projects**, create a project (name, brief, stack: `node`, `next` or `python`). A scaffold and a git repo are created in the sandbox.
3. Click **Run pipeline** and paste a build brief. The engine executes all five phases and streams logs, commands and self-heal attempts to the pipeline view.
4. Use **Chat** to talk to agents (`@morgan`, `@ada`, `@lin`, `@vera`, `@deacon`), or launch an autonomous run straight from chat.
5. Use **Agents** to tune models, prompts and temperatures, and to watch per-agent metrics.

### Default crew

| Handle | Agent | Role | Default model |
| --- | --- | --- | --- |
| `@product` | Morgan | Product Manager | `opencode/deepseek-v4.1-flash-free` |
| `@architect` | Ada | Systems Architect | `opencode/longcat-2.5-preview-free` |
| `@developer` | Lin | Developer | `ollama/qwen3.8:27b-mlx` (heavy local) |
| `@qa` | Vera | QA Engineer | `opencode/deepseek-v4.1-flash-free` |
| `@devops` | Deacon | DevOps | `opencode/glm-5.3-flash-free` |

Every agent has a fallback model; if a cloud call fails the router retries on the fallback.

## Architecture

```
src/
  app/                     Next.js App Router pages + API routes
    api/                   models, agents, projects, runs (+SSE), chat (+SSE), threads, settings, resources, health
  components/              UI (shadcn/ui primitives, app shell, agent/model/metric widgets)
  lib/
    orchestrator/          engine.ts (5 phases, self-heal, commits, CI, PR), prompts.ts, parse.ts
    providers/             catalog.ts (discovery), ollama.ts, opencode.ts (CLI worker), router.ts
    queue/                 resource-manager.ts (VRAM budget, heavy/light concurrency, queue)
    tools/                 terminal.ts (allowlisted runner), toolchain.ts, git.ts, github.ts, workflow.ts
    db.ts                  JSON persistence in .data
    workspace.ts           sandboxed file IO
```

### Model routing

- **Ollama** models are served over the native streaming `/api/chat` endpoint; token counts, TTFT and tok/s are captured server-side.
- **OpenCode cloud** models are free-tier and only usable from inside OpenCode, so the adapter runs `opencode run --agent plan --format json` in a scratch directory, parses the JSON event stream, and enforces a text-only contract (no tools). Cloud models use the provider's sampling defaults; `temperature` and `maxTokens` apply to Ollama calls. See the note in *Troubleshooting*.
- The **Resource Manager** treats cloud models as zero-VRAM. Heavy local models are queued (default `maxConcurrentHeavy: 1`) with a configurable queue timeout that falls back to a lighter model.

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

- Ollama / OpenCode URLs and OpenCode password (auto-read from `~/.config/opencode/service.json` when blank).
- VRAM budget, reserve, concurrency limits, queue timeout, fallback model.
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
