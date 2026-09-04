---
title: "What Does Cursor Store Locally? ~/.cursor/ + state.vscdb"
excerpt: "Cursor stores sessions across SQLite, JSONL transcripts, global state, checkpoints, and editor history. Here's how the layers connect—and what each tells you."
date: 2026-03-27
updated: 2026-09-03
readTime: "9 min read"
---

Run this right now:

```bash
du -sh ~/.cursor ~/Library/Application\ Support/Cursor 2>/dev/null
```

The output is specific to the machine and retention history. An illustrative audit might look like this:

| Path | Size |
|------|------|
| `~/.cursor` | **machine-specific** |
| `~/Library/Application Support/Cursor` | **machine-specific** |

One important caveat up front: this is a reader-oriented map of observed local storage, not an official Cursor storage specification. Folder names, schemas, and retention behavior can change between releases.

The exact sizes and counts on your machine will differ. The useful part is the shape of the system, not a number from someone else's disk.
The IDs, names, and numeric values in code samples below are synthetic examples.

The examples use macOS paths. Linux and Windows use different home and application-data roots, but the same distinction between chat stores, project transcripts, global state, and recovery sidecars still applies.

It is tempting to look for one obvious "session log" folder, the way Claude Code has `~/.claude/projects/*.jsonl`.

It doesn't.

A local audit usually reveals a layered system:

- SQLite chat databases in `~/.cursor/chats/`
- transcript JSONL files in `~/.cursor/projects/.../agent-transcripts/`
- a massive global state database at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- workspace state DBs, local file history, checkpoint diffs, and even separate AI-tracking tables on top of that

If you're building tooling on top of Cursor session data, this matters. If you're just curious where your chats went, it matters even more.

---

## Where are Cursor sessions actually stored?

Cursor session data is spread across **three primary sources**.

### 1. `~/.cursor/chats/*/*/store.db`

This is the cleanest "real chat database" layer.

There may be many local `store.db` files under `~/.cursor/chats/`; their count and size depend on how long the installation has been used.

A representative database has:

- tables: `meta`, `blobs`
- a small `meta` table
- a variable number of blob rows
- metadata fields like:
  - `agentId`
  - `latestRootBlobId`
  - `name`
  - `mode`
  - `createdAt`
  - `lastUsedModel`

One sample session metadata looked like this:

```json
{
  "agentId": "agent-demo-001",
  "name": "Review a workspace",
  "mode": "auto-run",
  "lastUsedModel": "example-model"
}
```

This is not "some cache." It's a real local conversation store.

### 2. `~/.cursor/projects/*/agent-transcripts/*.jsonl`

This is the most Claude-like layer.

An audit may also find transcript JSONL files and `agent-tools/*.txt` sidecars.

These transcripts can be flat:

```text
agent-transcripts/<session-id>.jsonl
```

or nested:

```text
agent-transcripts/<session-id>/<session-id>.jsonl
```

This is the easiest source to inspect by hand. It often contains the user-visible conversation text, and in some flows it also preserves image references and tool markers.

But it is not the whole story. On its own, it is incomplete.

### 3. `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`

This is where things get wild.

`state.vscdb` can become large because it stores key-value blobs as well as editor preferences.

It does not just hold preferences. It can hold large volumes of chat/composer state in a key-value table called `cursorDiskKV`.

The key families that matter most for replay and recovery include:

| Prefix | Typical role |
|--------|--------------|
| `agentKv` | Request-level messages and provider metadata |
| `bubbleId` | Conversation bubbles and tool state |
| `composerData` | Session summaries and conversation headers |
| `checkpointId` | Restore and inline-diff state |
| `messageRequestContext` | Prompt-building context snapshots |

So if you were imagining "Cursor stores some chats locally," undersell that by a lot. Cursor stores a **huge amount of local state**, and much of it is not in tidy text logs.

One important nuance: not every big key family here is equally useful for replay.

- `composerData` and `bubbleId` are the most obviously replay-relevant
- `messageRequestContext` looks more like prompt-building context snapshots
- `checkpointId` looks like restore / inline-diff state
- `agentKv` appears to be a separate message/blob store that is often tagged with request IDs

One useful observation is that `messageRequestContext:<uuid>:<uuid>` can share its **first** UUID with `composerData` / checkpoint session IDs, so this layer is better understood as a per-session context sidecar than as random junk.

An even more important nuance is that Cursor does **not** appear to use one universal session UUID across all of these stores.

The `store.db` session IDs and the `composerData` session IDs are not guaranteed to be the same. The transcript layer can sit across both:

Some transcript IDs match `store.db` sessions, some match `composerData` sessions, and some may not match either source cleanly.

The practical mental model is that Cursor has at least **two replay stacks**, and transcript JSONL can attach to either one.

---

## Cursor doesn't have one transcript format. It has a local storage stack.

This is the most important difference from Claude Code.

With Claude Code, the mental model is:

```text
session = one JSONL file
```

With Cursor, the practical model is closer to:

```text
store-backed session = store.db + optional transcript JSONL
composer-backed session = composerData + bubbleId + optional transcript JSONL + context / checkpoint sidecars
request-scoped provenance = agentKv + checkpoint metadata + ai_code_hashes
```

That complexity is exactly why tools like [vibe-replay](https://github.com/tuo-lei/vibe-replay) have to merge multiple Cursor sources instead of just reading one folder.

---

## How the pieces actually connect

The most useful observation is not "there are more tables." It is "these UUIDs do not all mean the same thing."

A public-safe mental model is:

- one replay stack built around `store.db`
- another replay stack built around `composerData` + `bubbleId`
- a transcript layer that can attach to either stack
- a separate request/provenance axis built around request IDs

In practice, that means:

- `store.db` session IDs can line up with transcript JSONL IDs
- `composerData:<session-id>` lines up cleanly with `bubbleId:<session-id>:<bubble-id>`
- the **first** UUID in `messageRequestContext:<uuid>:<uuid>` appears to line up with composer session IDs
- checkpoint `metadata.json.agentRequestId`, `agentKv.providerOptions.cursor.requestId`, and `ai_code_hashes.requestId` line up with each other

The important caution is that those request IDs are **not** the same thing as the main replay session IDs.

That is why Cursor feels more like a distributed local state system than a chat log: replay, request context, recovery, and attribution are all stored locally, but they are not all keyed the same way.

---

## What is inside `composerData` and `bubbleId`?

The replayable part of Cursor's global state is organized like this:

- `composerData:<session-id>`
- `bubbleId:<session-id>:<bubble-id>`

Not every `composerData:*` row is replayable. Some are more like summaries or stale state blobs. The key field is `fullConversationHeadersOnly`.

When that array is populated, you effectively get the bubble list for a session.

A synthetic replayable sample looks like this:

```json
{
  "name": "Reviewing a service configuration",
  "isAgentic": true,
  "fullConversationHeadersOnly": [
    { "bubbleId": "5d29a280-...", "type": 1 },
    { "bubbleId": "08f6cd6c-...", "type": 2, "serverBubbleId": "8f397408-..." }
  ]
}
```

Then each `bubbleId:*` row can carry far more than plain text:

- `text`
- `tokenCount`
- `images`
- `toolFormerData`
- `pullRequests`
- `relevantFiles`
- `recentlyViewedFiles`
- sometimes `thinkingDurationMs`
- sometimes `errorDetails`

A synthetic tool bubble looks like this:

```json
{
  "name": "run_terminal_cmd",
  "params": "{\"command\":\"git status\",\"requireUserApproval\":true}",
  "userDecision": "rejected",
  "result": "{\"rejected\":true}"
}
```

So Cursor isn't just storing "messages." It's storing structured traces of what the agent tried to do.

---

## How much of Cursor's behavior is visible locally?

More than a simple chat export, but in a fragmented way.

### Token counts

Some bubble payloads include token snapshots like:

```json
{
  "inputTokens": 41263,
  "outputTokens": 4901
}
```

That is enough for best-effort token and cost estimation for some Cursor sessions.

The important caveat is coverage: many sessions still have **no** usable token snapshots. In practice, aggregate Cursor cost totals can be a **lower bound**, not a full bill.

### Timing

Fields may include:

```json
{
  "thinkingDurationMs": 1200
}
```

So Cursor does expose some local timing signals. They just aren't sitting in one neat append-only log, and coverage is uneven enough that duration often has to be reconstructed from partial signals instead of read directly from one authoritative source.

### File context

Some bubbles included:

- `relevantFiles`
- `recentlyViewedFiles`

That means Cursor's local state sometimes preserves its own context-building breadcrumbs, which is fascinating if you're trying to understand what the model saw.

### Request-level message blobs

One of the largest families in `state.vscdb` can be `agentKv`, not `composerData`.

Readable `agentKv:blob:*` payloads can look like structured message objects with:

- `role`
- `content`
- sometimes `providerOptions.cursor.requestId`

The important takeaway is not the exact row count. It is that Cursor appears to keep a request-level message/blob archive with assistant text, tool traffic, reasoning blocks, and injected context wrappers like `<user_query>` and `<open_and_recently_viewed_files>`.

Do not treat `agentKv` as the main replay source yet. It is, however, strong evidence that Cursor stores more than just transcript text and chat summaries.

The safest interpretation is that `agentKv` sits on a **request/provenance axis**, not the main session axis. Checkpoint `metadata.json.agentRequestId` values can overlap request IDs in `agentKv` and `ai_code_hashes`, while the UUIDs in `messageRequestContext` have a different role.

---

## Does Cursor keep a prompt history?

Yes, but not in the same way Claude Code does.

```bash
~/.cursor/prompt_history.json
```

This file is typically a rolling list of prompt strings. Its size, entry limit, and retention behavior can change between releases.

That is important because it suggests **Cursor keeps a rolling prompt history locally**, but it does **not** look like Claude Code's rich `history.jsonl` global index with timestamps, project paths, and session IDs on every row.

So the safe statement is:

- Cursor stores local prompt history.

The unsafe statement is:

- Cursor stores a complete structured cross-project prompt log equivalent to Claude Code.

The evidence does not support that stronger claim yet.

---

## Can you recover files Cursor changed?

Partially, yes.

Cursor's docs say [Agent checkpoints are stored locally and are separate from Git](https://cursor.com/docs/agent/chat/checkpoints). Local checkpoint artifacts support that distinction, but their exact layout is version-dependent.

Local checkpoint artifacts commonly appear here:

```text
~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-commits/checkpoints/
```

Each checkpoint contains:

- `metadata.json`
- `diffs/<uuid>`
- `files/<uuid>`

One checkpoint metadata file included:

- `agentRequestId`
- `requestFiles`
- `deduplicatedGitInfos`
- `workspaceId`
- `startTrackingDateUnixMilliseconds`

And one diff payload looked like a real file-level patch snapshot with:

- `fsPath`
- `fileUuid`
- `diffChanges`
- `gitInfo`
- `kind`

So Cursor checkpoints are not just a UI concept. They have real local file artifacts behind them.

The relationship part matters too: the checkpoint folder's `metadata.json` is request-scoped. Its `agentRequestId` can line up with request IDs in both `agentKv` and `ai_code_hashes`, which makes checkpoints feel less like "chat history" and more like a provenance/recovery sidecar for specific agent requests.

There is also a **separate** recovery system:

```text
~/Library/Application Support/Cursor/User/History/
```

That's VS Code-style local file history, not AI chat history.

So if you're asking "can I recover what the AI touched?", the answer is:

- maybe from Cursor checkpoints
- maybe from VS Code local history
- maybe from Git

But unlike Claude Code, those answers are split across multiple systems.

---

## Cursor also keeps a separate AI tracking database

There is also a separate AI-tracking database:

```text
~/.cursor/ai-tracking/ai-code-tracking.db
```

It can contain tables like:

- `ai_code_hashes`
- `scored_commits`
- `tracked_file_content`
- `ai_deleted_files`
- `tracking_state`

This does **not** look like the main chat/session database. It looks more like Cursor's internal AI-attribution and provenance system.

The two most revealing tables were:

- `ai_code_hashes`, linking hashes to sources like `cli` and `composer`
- `scored_commits`, with fields like:

- `commitHash`
- `branchName`
- `tabLinesAdded`
- `composerLinesAdded`
- `humanLinesAdded`
- `v1AiPercentage`
- `v2AiPercentage`

In other words: Cursor appears to keep a local database specifically for tracking AI-touched code and commit-level attribution.

In some versions, `ai_code_hashes.conversationId` can overlap `composerData` session IDs, which suggests this attribution layer is not fully separate from Cursor's session model.

That is a very different kind of local artifact from a replay log, so I would treat it as a secondary storage layer, not "where the chats are."

---

## Does Cursor auto-delete old sessions?

There is no simple fixed local TTL visible across all of these stores.

The presence of older local artifacts does **not** prove that Cursor never cleans anything up. Retention is distributed across several stores and can depend on updates, user actions, workspace state, and provider policy. Do not assume a fixed TTL from one local audit.

The public docs are much stronger on privacy, checkpoints, usage, and cloud sharing than on local retention policy.

---

## What about workspace state?

There may also be workspace DBs here:

```text
~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb
```

These databases can contain keys like:

- `composer.composerData`
- `cursor/pinnedComposers`
- `history.entries`
- `workbench.backgroundComposer.workspacePersistentData`
- lots of `workbench.panel.aichat.<uuid>.numberOfVisibleViews`

This looks like chat/composer UI state glued into the editor workspace model. Useful, but not the best source of truth for replay.

---

## Cursor's official docs tell a different part of the story

If you read Cursor's docs, the emphasis is mostly on:

- [privacy and data handling](https://cursor.com/help/security-and-privacy/privacy)
- [usage and limits](https://cursor.com/help/models-and-usage/usage-limits)
- [checkpoints](https://cursor.com/docs/agent/chat/checkpoints)
- [subagents](https://cursor.com/docs/subagents.md)
- [shared transcripts](https://cursor.com/docs/shared-transcripts)

Those docs are useful, but they don't give you the same direct local-storage mental model that Claude Code's plain-text files do.

The reality on disk is messier and, in a way, more interesting.

Cursor is storing:

- transcript files
- chat databases
- global state blobs
- request-level message blobs
- workspace state
- prompt history
- checkpoint diffs
- local editor history
- AI attribution data

all at once.

---

## So what is Cursor's true equivalent of `~/.claude/`?

Not one folder.

The concise answer is:

**Cursor's equivalent is a storage system, not a transcript directory.**

In two sentences:

**Cursor appears to have at least two replay stacks locally, plus a separate request/provenance layer.**  
**That is the real reason local reverse-engineering and replay tooling for Cursor are harder than for Claude Code.**

The closest "core set" is:

```text
~/.cursor/chats/
~/.cursor/projects/
~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
```

plus the supporting layers:

```text
~/Library/Application Support/Cursor/User/workspaceStorage/
~/Library/Application Support/Cursor/User/History/
~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-commits/checkpoints/
~/.cursor/prompt_history.json
~/.cursor/ai-tracking/ai-code-tracking.db
```

That is the map to keep in mind before inspecting Cursor session replay.

---

## How can you inspect your own Cursor data?

Start with:

```bash
du -sh ~/.cursor ~/Library/Application\ Support/Cursor 2>/dev/null

find ~/.cursor/chats -name store.db 2>/dev/null | wc -l
find ~/.cursor/projects -name '*.jsonl' -path '*/agent-transcripts/*' 2>/dev/null | wc -l
find ~/.cursor/projects -name '*.txt' -path '*/agent-tools/*' 2>/dev/null | wc -l
```

If you want the interactive version instead of grepping databases:

```bash
npx vibe-replay
```

Cursor's local stores can contain prompts, file contents, command arguments, workspace paths, and recovery data. Read them locally, avoid uploading raw databases, and review any replay before sharing it.

It already knows how to merge Cursor's JSONL, SQLite, and global-state layers into a replayable session view, and newer builds can also surface some Cursor-specific sidecars such as request-context breadcrumbs and checkpoint-side metadata when those local artifacts exist.

Cursor stores a lot more locally than its UI reveals.

That is the headline.

The deeper point is that Cursor's local footprint is not one transcript directory you can casually inspect. It is a stack of overlapping systems for replay, recovery, request context, and attribution.

Once you look at it that way, the scattered files start to make sense.

If your sessions came from Cursor's programmatic SDK rather than the IDE, see [Where Does Cursor SDK Store Agents?](/blog/cursor-sdk-deep-dive/) for the separate `sdk-agent-store` layout.
