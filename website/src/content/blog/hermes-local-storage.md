---
title: "What Does Hermes Store Locally? state.db + Profiles"
excerpt: "Hermes keeps session metadata, token accounting, reasoning, and tool calls in SQLite — with named profiles and two different compaction signals."
cover: "/blog/hermes-storage/storage-map.png"
date: 2026-08-05
updated: 2026-09-03
readTime: "7 min read"
---

Hermes sessions look like conversations, but Hermes stores them like a small observability system.

The database knows things a transcript alone usually does not: the session’s model, Git branch, token totals, estimated and actual cost, profile, end reason, and whether the session is pinned. The message table then adds the visible conversation, reasoning, tool calls, and tool results.

The surprising part is that compaction is represented twice, and named profiles are separate databases. A parser that reads only the default file or counts every user row will produce a replay that is technically readable but semantically wrong.

The practical mental model is:

```text
~/.hermes/state.db
~/.hermes/profiles/<name>/state.db
        │
        ├── sessions       → catalog, usage, cost, Git metadata
        └── messages       → prompts, reasoning, tool calls, results
```

![Diagram of Hermes local storage: default and named-profile state.db files feeding session and message records](/blog/hermes-storage/storage-map.png)

vibe-replay discovers those databases together, keeps profile identity out of the prompt text, and renders the result as the same replay format used for other providers.

## Where does Hermes store sessions?

Hermes uses `~/.hermes` by default. `HERMES_HOME` can override the root, with one subtle rule: if it points inside the default Hermes root or inside a named profile, the provider still treats the default root as the installation root and scans sibling profiles.

The common layout is:

```text
~/.hermes/
├── state.db
├── .update_check
└── profiles/
    ├── work/state.db
    └── experiments/state.db
```

A custom installation outside `~/.hermes` can use that custom directory as its root. This is useful for containers and isolated test environments.

To inspect the layout without reading conversation data:

```bash
find "${HERMES_HOME:-$HOME/.hermes}" \
  -maxdepth 4 -name state.db -print
```

The `.update_check` file can contain the Hermes version. It is useful context when a schema looks different, but it is not part of the session transcript.

## What is in `state.db`?

The `sessions` table is the catalog. Depending on Hermes version, a row can contain:

- session id, title, working directory, and model;
- start, end, and last-activity timestamps;
- message and tool-call totals;
- input, output, cache-read, cache-write, and reasoning tokens;
- estimated cost and actual cost, with a cost status;
- Git branch and repository root;
- parent session and profile name;
- pin and end-reason flags.

The `messages` table carries the conversation. Hermes uses OpenAI-style roles, which makes the broad shape familiar:

```text
user       → prompt text or a compaction summary
assistant   → text, reasoning, and tool_calls JSON
tool       → tool_name, tool_call_id, and result content
```

That shape is convenient for a replay reader, but the JSON payloads still need validation. A malformed `tool_calls` value should become a parse warning for one message, not a reason to discard the entire session.

## Why named profiles matter

A profile is more than a UI preference. It has its own `state.db`, and two profiles can contain sessions with the same id shape. Scanning only `~/.hermes/state.db` makes a named profile look empty.

The safe discovery sequence is:

1. resolve the Hermes root;
2. include the default `state.db` if it exists;
3. enumerate `profiles/*/state.db`;
4. open only databases with the expected `sessions` and `messages` tables;
5. deduplicate session ids while preserving the first resolved database path;
6. sort the combined result by last activity.

When a session is later opened, the database path is part of the provider marker. That lets the parser find the right profile instead of guessing from the current `HERMES_HOME`.

## Hermes compaction appears in two forms

This is the detail most likely to make aggregate analytics lie.

### 1. Compacted transcript runs

Hermes can mark the pre-compaction history with `compacted = 1`. The rows remain in the database, so a full replay can preserve the history before the summary. A long session may contain several compacted runs.

The correct count is the number of **run boundaries**, not the number of rows with `compacted = 1`:

```text
normal normal compacted compacted normal compacted compacted
                    ↑ one boundary             ↑ another boundary
```

### 2. Summary marker rows

Some stores also contain a user message beginning with a marker such as:

```text
[CONTEXT COMPACTION ...]
```

That row is a compaction summary, not a human prompt. It should become a dedicated compaction event in the replay and should be excluded from prompt counts.

Older or summary-only stores may not have the `compacted` column. A robust reader falls back to the marker rows rather than declaring that the session never compacted.

This is a useful general rule: classify events by their provider semantics, not only by the role column they happen to use.

## Where do Hermes costs and tokens come from?

Hermes maintains usage fields on the session row and may also maintain a per-model usage table. The provider can report:

- actual cost when the store has it;
- estimated cost when actual billing is unavailable;
- zero when the store says cost is not included or unknown;
- token categories split by model.

Those values should not be recomputed from a local pricing table if Hermes already reported a total. A local estimate can be useful as a fallback, but it must not replace a provider-owned number or add itself on top of it.

The same caution applies to duration. `started_at` and `last_activity_at` define a broad window; message timestamps help estimate active time, but idle periods are not automatically model work.

## The SQLite WAL caveat

Hermes may be running with a write-ahead log:

```text
state.db
state.db-wal
state.db-shm
```

The `state.db` file can be structurally valid while the newest messages still live in WAL frames. A portable reader that loads only the database bytes may not see a long-running session until Hermes checkpoints.

That is not a reason to copy or mutate the live database. It is a reason to make the limitation visible: refresh after a checkpoint, keep the last stable cached version, or use the provider’s own export path when one exists.

## How vibe-replay reads Hermes

vibe-replay keeps the fast dashboard pass lightweight and defers full parsing until a session is opened. Discovery reads the catalog fields and aggregate counters; the replay parser then:

1. resolves the session id from a database marker;
2. prefers the hinted profile database;
3. falls back to probing known Hermes databases when needed;
4. reconstructs user prompts, assistant text, reasoning, and parallel tool calls;
5. joins tool results by `tool_call_id`;
6. preserves orphan tool results instead of undercounting activity;
7. emits compaction events and provider-reported usage separately.

The viewer can therefore show a full Hermes session without flattening away profile, cost, model, or compaction semantics.

## A safe way to inspect Hermes history

Start with schema and catalog metadata:

```bash
DB="${HERMES_HOME:-$HOME/.hermes}/state.db"
sqlite3 "$DB" 'pragma table_info(sessions);'
sqlite3 "$DB" \
  'select id, title, model, last_activity_at
   from sessions order by last_activity_at desc limit 10;'
```

Do not publish the database itself. It can contain prompts, reasoning, tool arguments, file contents, tokens, and paths. Use synthetic examples when writing bug reports, and review the generated replay before sharing it.

Hermes is a good example of why “read the transcript” is not a complete storage strategy. The durable truth is a profile-aware SQLite catalog plus an OpenAI-shaped message stream, with compaction and billing metadata that deserve their own logic. Once you model those layers separately, the replay becomes both more accurate and more honest about what the source actually recorded.

For comparison, see [OpenCode’s relational session database](/blog/opencode-local-storage/) and the JSONL tree used by [Pi coding agent](/blog/pi-local-storage/).
