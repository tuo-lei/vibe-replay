---
title: "Where Does Cursor's SDK Actually Store Your Agents? A Deep Dive into sdk-agent-store"
excerpt: "The Cursor SDK lets you run coding agents programmatically from TypeScript. The result is a brand-new local storage layer — separate from the IDE chat database, with its own schema, its own event stream, and its own tool-result format. Here's what's inside."
date: 2026-05-22
readTime: "8 min read"
---

Run this right now:

```bash
find ~/.cursor/projects -name index.db -path '*/sdk-agent-store/*' 2>/dev/null
```

Anything that prints is a Cursor session you didn't create from the IDE. It came from `@cursor/sdk` — Cursor's TypeScript SDK for running coding agents programmatically — and it lives in a completely different storage layer than your regular Cursor chats. Different folder, different schema, different event stream. The IDE's session picker doesn't list these. None of the usual [`~/.cursor/chats/` and `state.vscdb` advice](/blog/cursor-local-storage/) applies.

I learned this the hard way while adding SDK support to [vibe-replay](https://github.com/tuo-lei/vibe-replay) in v0.2.1. Below is the map I wish I had on day one.

---

## What is the Cursor SDK?

Quick context for anyone who hasn't touched it yet.

`@cursor/sdk` is a TypeScript package that lets you spin up a Cursor agent from code — give it a workspace, send it a prompt, get back a stream of events as it edits files, runs commands, and thinks out loud.

It's the same agent loop you'd get inside Cursor's chat panel, just driven from a script instead of the IDE.

That means:

- no editor UI
- no `composerData` / `bubbleId` rows in `state.vscdb`
- no entry in the IDE's `/resume` history

The state has to live *somewhere* though, and it does — in its own little SQLite world.

---

## Where SDK agents actually live on disk

On macOS, every SDK agent lands at:

```text
~/.cursor/projects/<workspace-slug>/sdk-agent-store/<projectHash>/index.db
```

A few things worth flagging right away:

- **`<workspace-slug>`** is the same folder the existing Cursor provider already walks for IDE transcripts. The SDK is reusing the per-project root, just in a new `sdk-agent-store/` subdirectory.
- **`<projectHash>`** is an opaque hex-looking identifier — I haven't reverse-engineered exactly what's being hashed, but treat it as "one stable directory per project + how you opened it."
- **`index.db`** is the per-project catalog. It is *not* the per-agent blob store (more on that below).

Each project hash gets its own `index.db`, plus a sibling per-agent store:

```text
~/.cursor/projects/<workspace-slug>/sdk-agent-store/<projectHash>/
├── index.db                          ← catalog: agents, runs, events
└── agents/
    └── <sha256(agentId)>/
        └── store.db                  ← per-agent blob/checkpoint store
```

The interesting bit is that the agent ID directory is **hashed**. If you `ls agents/` you'll see a bunch of 64-character hex names with no obvious correspondence to the agent IDs in `index.db`. To find the store for a given agent, you have to hash the agent ID yourself.

For replay purposes I never had to crack open `store.db` — the catalog already contains everything that ends up rendered in the UI. But it's good to know the blob store is there if you ever need to recover raw payloads.

---

## The `index.db` schema (schemaVersion 1)

Three tables do all the work:

```text
agents      — top-level agent records
runs        — one row per turn within an agent
run_events  — the streaming event log (sdk_message envelopes)
```

### `agents`

What you find on inspection:

| Column | Meaning |
|---|---|
| `agent_id` | UUID-ish identifier, prefixed `agent-` in our experience |
| `workspace_ref` | Path or ref back to the workspace |
| `status` | e.g. `IDLE`, `RUNNING`, `COMPLETED` |
| `name` | Optional human label for the agent |
| `created_at` / `updated_at` | ISO timestamps |
| `latest_checkpoint_ref_json` | Pointer into the blob store |

The `agent-` prefix on `agent_id` is load-bearing for tooling — it's the only reliable way to tell an SDK agent apart from a plain IDE chat session (which is a bare UUID).

### `runs`

One row per turn. This is where the per-turn metadata sits:

| Column | Meaning |
|---|---|
| `run_id` | UUID |
| `agent_id` | FK back to `agents.agent_id` |
| `turn_number` | Monotonic, 0-indexed |
| `status` | Per-run status |
| `model` | Model name actually used for this turn |
| `started_at` / `finished_at` | ISO timestamps |
| `result` | Final assistant text for the run (if recorded) |

A subtle but useful fact: **`model` is per run, not per agent.** If you switch models mid-conversation, the SDK records each turn's actual model — which is great for cost attribution, and matches what we already do for Claude Code's per-turn model field.

### `run_events`

This is the firehose. Every streamed SDK message becomes a row:

| Column | Meaning |
|---|---|
| `run_id` | FK back to `runs.run_id` |
| `seq` | Monotonic sequence within a run |
| `event_type` | Always `run_stream_event` in our reads |
| `payload_json` | The actual `sdk_message` envelope |

`payload_json` is the JSON payload from the SDK's `agent.events()` stream. Each row's `message.type` tells you what kind of event it is — assistant text deltas, tool calls, tool results, thinking blocks, and so on.

For replay, the message type that matters most is `tool_call`.

---

## How tool calls are encoded

A `tool_call` message looks roughly like this:

```json
{
  "type": "tool_call",
  "call_id": "call_01HF...",
  "name": "shell.execute",
  "args": { "command": "pnpm test" },
  "status": "running",
  "result": null
}
```

And later, for the same `call_id`:

```json
{
  "type": "tool_call",
  "call_id": "call_01HF...",
  "name": "shell.execute",
  "args": { "command": "pnpm test" },
  "status": "completed",
  "result": {
    "status": "ok",
    "value": {
      "stdout": "✓ 42 passed\n",
      "stderr": "",
      "exitCode": 0
    }
  }
}
```

A few things to notice:

1. **The same `call_id` appears multiple times.** You get a `running` event first, then one or more updates, then a terminal `completed` / `error`. To replay correctly you have to collapse them per `call_id` and take the last status / result you see.
2. **`result` is a `{ status, value }` envelope.** Not raw text. For Bash-shaped tools `value` carries `stdout`, `stderr`, `exitCode`. For file reads `value.content`. For edits `value.diffString`.
3. **`args` may grow across updates.** Sometimes the early "running" event has a thin args object and the args fill in by the next update. The right strategy is to take the latest non-empty `args`, not the first one we see.

That last one bit me. My first pass just used the args from the first `running` event and missed late-arriving fields on long-running tools. Switching to "latest non-empty wins" fixed it.

---

## What's *not* in `run_events`

Here's the gotcha that surprised me most.

**User prompts don't appear in `run_events`.**

I expected the SDK to log everything in one place, but the event stream is purely about agent output: thinking, tool calls, tool results, assistant text. The user-facing prompts that *triggered* those runs aren't in there.

So where do they live?

In the **parallel JSONL transcript**:

```text
~/.cursor/projects/<workspace-slug>/agent-transcripts/<agentId>/<agentId>.jsonl
```

This file is human-readable and contains the user-side conversation in the same shape you'd see in the IDE's transcript export. It's the source of truth for "what did the user actually say."

The SDK index DB and the JSONL transcript are **complementary**, not redundant:

| Source | Has | Doesn't have |
|---|---|---|
| `index.db` (`run_events`) | tool calls, tool results, per-turn model, per-turn timing | user prompts |
| `agent-transcripts/*.jsonl` | user prompts, assistant text, thinking | structured tool results, per-turn timing |

If you read only the JSONL, you'll show tool calls with no outputs. If you read only `index.db`, you'll show agent activity with no inciting user prompt. You have to merge.

That's what `applySdkEnrichmentToTurns` in [`sdk-reader.ts`](https://github.com/tuo-lei/vibe-replay/blob/main/packages/cli/src/providers/cursor/sdk-reader.ts) does — it walks the JSONL as the spine, then fills in tool results, per-turn models, and run-level durations from the SDK store.

---

## How to detect an SDK session vs. an IDE chat

If your tool already handles regular Cursor sessions, the natural question is: when do I read `sdk-agent-store` instead of `store.db`?

The cheap heuristic that works in practice:

```text
sessionId starts with "agent-"  →  SDK session
sessionId is a bare UUID         →  IDE chat session
```

That's literally the check we use in `vibe-replay`. It avoids paying SQLite cost on every IDE session probe (and avoids the messy job of joining UUIDs across the IDE's three storage layers).

A more robust check, if you don't trust the prefix on future versions:

1. Look for `sdk-agent-store/<projectHash>/index.db` inside the workspace directory at all.
2. If `index.db` exists, query `SELECT 1 FROM agents WHERE agent_id = ?` for the candidate session ID.

For now the prefix is good enough.

---

## Tool name and arg quirks

The SDK uses different tool names than the IDE chat. Some examples we hit:

- `shell.execute` instead of `Bash`
- `file.read` instead of `Read`
- `file.edit` / `file.write` / `file.multi_edit` instead of `Edit` / `Write` / `MultiEdit`

For replay we map them back to canonical tool names so the UI looks consistent across providers. The mapping is shared with the IDE Cursor reader (`mapCursorToolName`) so adding a new tool only takes one edit.

The `args` shapes are usually close to the canonical Cursor names, but the **result** shapes are where the SDK diverges most. The biggest one: for `file.edit`, the SDK gives you `value.diffString` (a unified diff), not the `oldString` / `newString` pair the IDE stores. Downstream code that wants to render before/after has to parse the diff back out — or, like we do, wrap the SDK result in the `diff.chunks[].diffString` envelope the existing IDE inference helpers already understand.

---

## Per-agent `store.db` — and why we ignore it

For completeness: each agent has its own `store.db` under `agents/<sha256(agentId)>/`. This is the *per-agent* blob store, distinct from the *project-level* `index.db`.

We haven't found anything in there that isn't already reachable from `index.db` + the JSONL transcript. So `sdk-reader.ts` never opens it.

If Cursor changes that — e.g. starts writing thinking blocks or images there instead of the JSONL — we'd add a second pass. For now, one less thing to merge.

---

## Putting it together

The full SDK storage picture, for one workspace:

```text
~/.cursor/projects/<workspace-slug>/
├── agent-transcripts/
│   └── <agentId>/
│       └── <agentId>.jsonl              ← user prompts + assistant text
└── sdk-agent-store/
    └── <projectHash>/
        ├── index.db                     ← agents / runs / run_events
        └── agents/
            └── <sha256(agentId)>/
                └── store.db             ← per-agent blob store (unused for replay)
```

To rebuild a session you:

1. Read the JSONL transcript — that's the user-facing conversation skeleton.
2. Open `index.db`, find the matching `agent_id`.
3. Pull `runs` ordered by `turn_number`.
4. Pull `run_events` for those runs, collapse `tool_call` events by `call_id`.
5. Walk the JSONL turns, pairing each `tool_use` block with the next SDK tool call in the same run, and copy the SDK `result` into the JSONL block.
6. Use per-run `model` and `started_at` / `finished_at` to tag turns with the model actually used and per-turn duration.

That's it. There's no hidden third source.

---

## Why this matters

A few reasons the SDK store is interesting beyond "more files in `~/.cursor`":

- **It's a different model from the IDE.** No `composerData`, no `bubbleId`, no `state.vscdb` involvement. Cleaner schema, easier to reason about, easier to back up.
- **It's the only place in Cursor's local storage where per-turn timing and per-turn model are first-class fields.** The IDE bubble layer has scattered hints (`thinkingDurationMs` on some bubbles, `lastUsedModel` on a session). The SDK index DB has them on every run as actual columns.
- **It's the first Cursor surface where the local schema feels designed for programmatic consumers.** Stable column names, JSON envelopes, monotonic sequence numbers. If you've ever tried to write Cursor IDE replay tooling against `state.vscdb`, the contrast is sharp.

If Cursor's SDK keeps growing, this is probably going to become the *cleaner* of the two Cursor replay stacks.

---

## What `vibe-replay` does with all this

As of v0.2.1, [vibe-replay](https://github.com/tuo-lei/vibe-replay) automatically detects SDK sessions (the `agent-` prefix trick), opens `index.db` read-only, and merges its run/event data onto the JSONL transcript so:

- tool calls show real outputs (stdout, file content, diffs) instead of "result pending"
- each assistant turn carries the actual model used
- per-turn duration is reconstructed from `runs.started_at` / `finished_at`

If the `find` command at the top of this post printed anything, those agents are already replayable — the next `npx vibe-replay` run will pick them up alongside your regular Cursor and Claude Code sessions, same picker, same dashboard, same HTML output.

If it printed nothing, you haven't run an SDK agent on this machine yet. Spin one up, then come back and check.

---

## The short version

- The Cursor SDK has its own local storage stack, fully separate from the IDE chat.
- Catalog lives in `~/.cursor/projects/<workspace>/sdk-agent-store/<hash>/index.db` with tables `agents`, `runs`, `run_events`.
- User prompts come from a parallel `agent-transcripts/*.jsonl`; the SDK DB provides tool results, per-turn model, and timing.
- SDK session IDs start with `agent-`, which is the cheapest way to route to the right reader.
- The schema is dramatically cleaner than the IDE chat layer — if you're building Cursor tooling, this is the surface you want to bet on.

That is the map. The reverse-engineering is done. Go run some agents.
