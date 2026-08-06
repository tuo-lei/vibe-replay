# Cursor subagent visibility — investigation and fix

Status: **code changed, uncommitted, and fully verified.** Nothing has been
staged or committed; the working tree holds the changes.

## TL;DR

vibe-replay reported `subAgentCount: 0` for every Cursor session ever recorded.
It was not a regression — Cursor delegation had never been wired up correctly.
Two independent defects had to line up, and both did, so **100% of Cursor
delegation was invisible**: 508 delegation calls and 12,242 tool calls executed
inside subagents (9.6% of all recorded tool work) were missing from stats, the
dashboard, insights, and the viewer's sub-agent panel.

While verifying the fix, a second, unrelated and higher-blast-radius bug
surfaced: a drifted opencode SQLite schema made `sessions` discovery throw, and
because `discoverAllSessions()` had no per-provider isolation, **that single
failure took down session listing for every provider**, Cursor and Claude Code
included.

The original four fixes are small. A follow-up now also reads Cursor's sibling
subagent transcripts and attaches their full available trajectories to the
delegation scenes.

## Bug 1 — `Subagent` was missing from the Cursor tool-name table

`packages/provider-cursor/src/cursor/tool-mapping.ts`

Cursor writes the delegation tool under three different names depending on the
surface. The mapping table knew two of them:

```ts
Task: "Agent",
task_v2: "Agent",
```

IDE transcripts overwhelmingly use a third name, `Subagent`, which was absent.
`mapCursorToolName` falls through to `return name`, so `Subagent` passed through
unmapped. Every downstream consumer keys on the canonical `"Agent"` name:

- `replay-core/src/transform.ts:131` — the Cursor-specific branch that builds
  `scene.subAgent` and `meta.subAgentSummary`
- `cli/src/scanner.ts:894` — `derivedSubAgentCount`
- `cli/src/scanner.ts:902` — attributing subagent file edits to the session
- the viewer's `StatsPanel` / `Dashboard`, which read `scene.subAgent`

None of them ever fired. Note the Cursor handling in `transform.ts` was already
written and correct — it was simply unreachable.

Measured on the local transcript corpus (`~/.cursor/projects`):

| Tool name | Delegation calls |
|---|---|
| `Subagent` | 477 |
| `Task` | 31 |

**Fix:** added `Subagent: "Agent"` to the mapping table.

## Bug 2 — the argument extractor read the wrong key casing

`packages/provider-cursor/src/cursor/tool-mapping.ts`

This is why fixing Bug 1 alone would not have been enough, and why even the 31
correctly-named `Task` calls were also invisible:

```ts
if (toolName === "task_v2" || toolName === "Task") {
  return {
    ...
    ...(argsObj.subagentType ? { subagent_type: argsObj.subagentType } : {}),
  };
}
```

The extractor read camelCase `subagentType`. Transcripts use snake_case
`subagent_type` — **505 occurrences of `subagent_type`, zero of `subagentType`.**
So the key was dropped from the mapped args, and `buildMinimalCursorSubAgent`
(`transform.ts:378`) bails out with `return null` when `input.subagent_type` is
missing. The `Task` path was dead too.

**Fix:** match `Subagent` as well, accept either key spelling, and additionally
pass through `model` — Cursor records a per-delegation model override, which is
exactly the field needed to reason about main-seat vs subagent-seat model cost.
`buildMinimalCursorSubAgent` now populates `SubAgent.model` from it.

## Bug 3 — one bad provider took down discovery for all providers

`packages/cli/src/index.ts:223`

```ts
for (const provider of providers) {
  const sessions = await provider.discover();   // unguarded
  allSessions.push(...sessions);
}
```

A single `provider.discover()` throw rejected the whole function, so
`vibe-replay sessions` exited non-zero and printed nothing at all. The correct
pattern already existed elsewhere in the codebase —
`server.ts:1973` wraps each provider and even carries the comment *"One provider
failing to discover must not abort discovery for the rest."* `discoverAllSessions`
just never adopted it.

**Fix:** per-provider `try/catch`, with the failure surfaced under
`VIBE_REPLAY_DEBUG` so partial failures stay diagnosable without spamming normal
runs.

## Bug 4 — opencode's SQLite schema drifted upstream

`packages/provider-opencode/src/opencode/discover.ts`

The discovery query selected `s.agent`, `s.model`, `s.cost`, `s.tokens_input`,
`s.tokens_output`. Current opencode has dropped all five from the `session`
table, so the query failed with `no such column: s.agent` — which is what was
triggering Bug 3.

Actual local schema (`~/.local/share/opencode/opencode.db`, 18 sessions):

```
id project_id parent_id slug directory title version share_url
summary_additions summary_deletions summary_files summary_diffs
revert permission time_created time_updated time_compacting time_archived
```

**Fix:** probe `PRAGMA table_info` and project only the columns that exist. The
required columns stay mandatory; the five volatile ones are optional and degrade
to `undefined`. The `project` join and the `parent_id` subagent filter are also
applied conditionally.

## Verification

Ground truth was taken by reading the raw transcript tree directly, independent
of vibe-replay, then compared against scanner output.

`subAgentCount` from `vibe-replay sessions --provider cursor --scan --json`
(every one of these was `0` before):

| Session | Scanner | Raw delegation calls on disk |
|---|---|---|
| `fb6dee83` | 3 | 3 |
| `55d8c12a` | 1 | 1 |
| `825f9e4f` | 7 | 7 |
| `7ee29a9d` | 12 | 11 in the primary shard, plus a merged `/resume` shard |
| `a91882f5` | 2 | 2 |

Provider inventory, end to end:

| Provider | Before | After |
|---|---|---|
| cursor | listing crashed | 100 sessions |
| claude-code | listing crashed | 24 sessions |
| opencode | 0 (query threw) | 16 sessions |
| pi | listing crashed | 70 sessions |

Suite: `pnpm lint:check` clean, `pnpm test` green across all 11 packages —
1107 tests, up from 1092 (15 new regression tests, no existing test touched).

The new parser path was also checked against four real local sessions, without
printing conversation content:

| Session | Delegations | Linked transcripts | Subagent tools | Subagent scenes |
|---|---:|---:|---:|---:|
| `55d8c12a` | 1 | 1 | 23 | 45 |
| `fb6dee83` | 3 | 3 | 239 | 256 |
| `825f9e4f` | 7 | 6 | 564 | 648 |
| `a91882f5` | 2 | 2 | 207 | 231 |

The one unlinked `825f9e4f` delegation has no sibling transcript on disk. Its
minimal summary remains visible, so the session still reports all 7
delegations rather than regressing to the 6 linked files.

## What this unlocks

Delegation is now measurable. From the raw corpus:

- 12,242 tool calls run inside subagents, **9.6%** of all recorded tool work
- 508 delegation calls, amplifying ~24× into subagent tool calls
- Delegation is overwhelmingly read-only reconnaissance — `ReadFile` 5,737,
  `rg` 2,820, `Shell` 1,381, `Glob` 778, `Read` 304, `Grep` 177
- `subagent_type` mix: `explore` 407, `generalPurpose` 48, `browser-use` 27,
  `shell` 14, `cursor-guide` 9, `ci-investigator` 7, `pr-ci-green` 1

The earlier conclusion drawn from the broken data — *"you barely delegate, 0.44%
of tool calls, you should delegate more"* — was an artifact of these bugs and is
**retracted**. Delegation is heavy, and it is concentrated in exactly the
read-only exploration role that the research supports putting a cheap model in.

## Follow-up — full available subagent trajectories

`packages/provider-cursor/src/cursor/parser.ts` now discovers sibling files at:

```text
agent-transcripts/<sessionId>/subagents/<subAgentId>.jsonl
```

Cursor does not put the subagent file ID on the parent `Task` / `Subagent` tool
call. It does repeat the delegated prompt in the subagent's initial user
message, so the parser links the two sources by normalized prompt containment.
It deliberately leaves unmatched files unattached instead of guessing by file
order, because concurrently running agents can finish in a different order.

For each linked transcript, the replay now includes:

- the stable subagent ID from the filename;
- canonical tool names and normalized tool arguments;
- all available tool-call, reasoning, and text-response scenes (no silent
  60-scene cap);
- tool/thinking/text counts in both the inline subagent panel and metadata
  summary;
- file-edit scenes that the scanner can attribute back to the parent session;
- explicit delegation model/type/description metadata from the parent call.

This works for both JSONL-primary sessions and SQLite/global-state-primary
sessions supplemented by JSONL. Malformed subagent lines produce the same
structured parse warnings as malformed parent transcripts.

Important source limitation: Cursor's subagent JSONL currently records
`tool_use` blocks but no tool IDs, `tool_result` blocks, timestamps, token usage,
or actual per-subagent model. The replay therefore shows the full trajectory
available on disk, but tool results and those metrics remain unavailable rather
than being inferred.

## Known remaining gaps

1. **Latent: scanner's subagents-dir path is Claude-Code-shaped.**
   `cli/src/scanner.ts:576` derives the directory as
   `<file-without-.jsonl>/subagents`. That is right for Claude Code
   (`<proj>/<id>.jsonl` → `<proj>/<id>/subagents/`) but wrong for Cursor, whose
   transcript already sits one level deeper
   (`agent-transcripts/<id>/<id>.jsonl` → the real dir is
   `agent-transcripts/<id>/subagents/`, not `.../<id>/<id>/subagents/`).
   This was **not** the cause of the reported symptom: Cursor reaches this code
   only when `scanCursorSession` throws (`scanner.ts:351`). Parser-level
   transcript ingestion now supersedes it: `parsedSubAgentCount` wins and the
   fallback normally stops mattering. Fix it if that fallback is touched
   independently.

2. **`subAgentCount` is hardcoded `0`** in the lightweight scan builders for
   deferred Cursor (`scanner.ts:799`), opencode (`:827`), and Hermes (`:855`).
   Background insight scans therefore still under-report delegation.

3. **No per-subagent model attribution in the data itself.** We now surface an
   explicit `model` override when the delegation specifies one, but Cursor does
   not record which model a subagent actually ran on. The SDK store
   (`sdk-agent-store/<hash>/index.db`) keys usage by top-level `agent_id`/
   `run_id` only, and `runs.usage_json` is populated for just 29/443 rows (6.5%).
   Attributing cost to the subagent seat is not possible from local data today.

4. **Distrust rate is computable but not computed.** Because subagent transcripts
   contain full tool sequences, the main agent re-running the same `rg`/`ReadFile`
   immediately after a delegation returns *can* be measured locally. That was
   previously assumed impossible. It depends on item 1 landing first.

## Files changed

| File | Change |
|---|---|
| `packages/provider-cursor/src/cursor/tool-mapping.ts` | map `Subagent` → `Agent`; accept both `subagent_type`/`subagentType`; pass through `model` |
| `packages/provider-cursor/src/cursor/parser.ts` | discover, parse, safely correlate, and attach sibling subagent trajectories |
| `packages/replay-core/src/transform.ts` | populate `SubAgent.model` from the delegation input |
| `packages/cli/src/index.ts` | per-provider `try/catch` in `discoverAllSessions` |
| `packages/provider-opencode/src/opencode/discover.ts` | schema-tolerant `SELECT` via `PRAGMA table_info` |
| `packages/provider-cursor/test/subagent-tool-mapping.test.ts` | new — 6 regression tests |
| `packages/provider-cursor/test/subagent-transcript.test.ts` | new — JSONL/SQLite linking, scene fidelity, malformed input, and 500-tool large-session coverage |
| `packages/provider-opencode/test/discover-schema-drift.test.ts` | new — 3 regression tests |

Environment note: `pnpm install --frozen-lockfile` was needed first —
`provider-hermes` and `provider-opencode` had no workspace symlinks, so
`pnpm --filter vibe-replay build` failed to resolve them. The lockfile was not
modified.
