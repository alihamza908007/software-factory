# Flow optimization notes

Audit of the end-to-end flow (run launch → phases → guardrails → repair → delivery, chat/mesh
routing, and the data/state layer). All items from the first audit pass have now been addressed.

## Done

### Final architectural pass
- **Durable phase checkpoints.** Requirements, architecture, implementation files and testing
  verification are saved on the run. Resume restores the spec/architecture text, replays saved
  implementation files instead of regenerating them, and reuses verification results.
- **Ordered, resumable streams.** Run SSE events carry sequence ids; the client reconnects with
  `Last-Event-ID`/`since` and replays only missed events. Chat SSE events are sequenced and
  de-duplicated. The two streams remain separate endpoints (full protocol unification is
  intentionally out of scope).
- **Branch-scoped dead-loop freezing.** A detected loop now freezes only the offending handoff
  branch; sibling branches continue.
- **Canvas resume replays node outputs.** The canvas branch saves the DAG node outputs to the
  implementation checkpoint after the run passes; a resume at implementation replays them
  instead of re-running the DAG.
- **Capability inference no longer reads system prompts.** `agentCapabilities` scores from
  declared capabilities, agent identity fields and the one-line role/description, so
  long task instructions no longer hand every agent a full capability set.

### Run / pipeline
- **Verification reuse.** A per-run cache keyed by a workspace content fingerprint lets
  testing and deployment reuse an earlier passing build/test result when no source file changed.
  `writeProjectFile` now invalidates the workspace listing cache immediately, and the
  package-manifest shared-cache entry is cleared when the manifest is rewritten.
- **Lint + tests run concurrently by default**, both in the engine and the New Run dialog.
- Skip negotiation/decomposition for canvas runs; honor the per-run heal budget and the
  Push & draft PR toggle.
- **Incremental DAG repair.** On a canvas repair pass only failed/blocked nodes and their
  downstream dependants are re-executed; all other nodes reuse their previous output.
- **Resume correctness.** `finishPhase` advances `currentPhase`, resume prefers the first
  incomplete phase, and runs carry an engine marker so a canvas run can never silently
  resume through the legacy five-phase engine.
- Single log ID per line; cancel no longer emits a second terminal event.

### Chat / mesh
- **Prompt compaction.** The injected roster is now a compact handle/name/role list, the
  duplicated guardrail block was removed, the supervisor no longer embeds a second roster,
  and handoff file trees are capped at 40 paths.
- **Event durability.** Validation completes before the stream closes, and routing,
  guardrail/handoff and dead-loop notices are persisted as system messages so they survive
  the client's thread refetch.
- User message is no longer duplicated in each prompt; reroute tokens stream as deltas;
  disabled agents are excluded from fallbacks and chips; abort no longer persists an error;
  `NEXT_AGENT:` directives are honored; tokens include handoffs.
- **Real dead-loop detection.** A coarse, punctuation-insensitive progress hash replaces the
  hard-coded `progressed: true`, and the trace is no longer reset at the start of every turn.
- `parseMentions` ignores fenced/inline code and emails.

### Data / system
- Health: static hardware facts and `vm_stat` output are cached; the client polls health every
  20 s (runs still 7 s). Map lookups replace O(n×m) scans; duplicate page-load fetches removed;
  mesh stream torn down on unmount; compact DB writes with a safe reset path.

## Remaining architectural work

- A single unified endpoint for chat and mesh events (with server-side replay of chat turns
  across a full page reload) would require a durable event log, not just sequence ids.
