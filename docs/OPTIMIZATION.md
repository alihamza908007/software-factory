# Flow optimization notes

Audit of the end-to-end flow (run launch → phases → guardrails → repair → delivery, chat/mesh
routing, and the data/state layer). Each finding is tagged with the risk of changing it.

## Applied (low-risk batch)

| Change | Why |
| --- | --- |
| Single `uid("log")` per log line | Stored and streamed logs previously had different IDs. |
| Skip negotiation/decomposition for canvas runs | Those phases are marked `skipped` on the DAG path, so the work was wasted. |
| Honor the per-run **self-heal budget** in all repair loops | The New-run control had no effect; loops used the global setting. |
| Honor **Push & draft PR** | The dialog toggle was ignored; push was gated only on stored credentials. |
| `Map` for runs in `/api/projects`, metrics/models in Agents | Removes O(n×m) scans. |
| Single workspace scan for chat history, cached tree per turn | Chat rescanned the workspace up to four times per turn. |
| Drop the duplicated user message from chat prompts | It was appended to history and appended again by `chatPrompt`. |
| Send token deltas (not full text) on reroute/recovery | Avoided quadratic payload growth per streamed answer. |
| Enabled-only agent fallbacks and mention chips | Disabled agents could be selected or shown before the late guard. |
| Abort special-case in chat | Stop no longer persists "Generation failed: Aborted". |
| View-run action on the autonomous-run toast | Chat previously only said "Watch the agents in the Pipeline view". |
| Tear down the mesh stream on shell unmount | `disconnectMesh()` existed but was never called. |
| Remove duplicate page-load fetches | `refreshAll()` already loads projects and canvas. |
| Compact DB writes; fix stale pending write on reset | Full pretty-printed rewrite on every log line; reset could be overwritten. |

## Remaining opportunities

### High value, medium risk
- **Reuse verification results across phases.** `verifyProjectRuntime` (implementation),
  `runVerification` (testing) and `runBuild` (deployment) run the same build/test suite up to
  three times per run. Share one digest with a per-run cache.
- **Compact prompts.** The agent roster and guardrails are injected on every model call, the
  supervisor embeds the roster again in the user message, and handoff prompts render up to 120
  absolute file paths. A condensed roster + relevant-files-only tree would cut token spend.
- **Validate once per artifact batch, off the critical path.** Background Silent Witness LLM
  calls compete with generations for the VRAM queue. Coalesce artifacts and disable during runs.
- **Reduce the 7 s `/api/health` poll.** It spawns `vm_stat`, probes three providers and
  recomputes static hardware facts. Cache static facts and drop the duplicate `os.cpus()`.
- **Per-turn context object.** Settings, agents, roster prompt, file tree and project spec are
  re-derived in each layer. Build once and thread it through generation/handoff/validation.

### High value, high risk (architectural)
- **Incremental DAG repair.** Canvas repair currently re-executes every node up to four times.
  Re-run only failed and downstream nodes with cached outputs.
- **Durable phase checkpoints.** Resume restarts the whole current phase. Persist generated
  files, verification result and git commit at phase boundaries, then replay on resume.
- **Advance `currentPhase` on `finishPhase` and tag runs with their engine kind.** A crash
  between phases can re-run a passed phase; a canvas run paused in testing can silently resume
  through the legacy five-phase engine.
- **Unify chat SSE and the mesh bus into one ordered, resumable event stream.** Today routing
  and handoff frames are transient and disappear when the client refetches the thread, and
  validation events are sent after the stream closes so they never reach the UI.
- **Real dead-loop detection.** The `progressed` flag is hard-coded to `true`, so only exact
  payload hashes count; chat also resets the trace every turn.

### Small correctness gaps
- `finishPhase(..., "failed")` no longer reports 100% progress; failed phases now keep their
  progress. (Applied.)
- Cancel emits two terminal events (`cancelRun` and `executeRun`'s catch). De-duplicate.
- `NEXT_AGENT:` is emitted by the supervisor prompt but never parsed by the router.
- `parseMentions` matches `@` inside code blocks and emails; unknown handles can add an agent
  to the wave.
- Token counts in the chat header exclude handoff messages.
