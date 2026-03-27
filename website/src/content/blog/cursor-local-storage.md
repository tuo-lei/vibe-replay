---
title: "What Does Cursor Store on Your Machine? A Deep Dive into ~/.cursor/ and state.vscdb"
excerpt: "2.1 GB in ~/.cursor/, another 4.9 GB in Application Support, and a 1.2 GB state.vscdb. Cursor's local data is everywhere: transcripts, SQLite chat stores, global state blobs, checkpoints, and editor history."
date: 2026-03-27
readTime: "9 min read"
---

Run this right now:

```bash
du -sh ~/.cursor ~/Library/Application\ Support/Cursor 2>/dev/null
```

On my Mac, that prints:

| Path | Size |
|------|------|
| `~/.cursor` | **2.1 GB** |
| `~/Library/Application Support/Cursor` | **4.9 GB** |

One important caveat up front: this is a local audit of one heavily used macOS machine, not an official Cursor storage spec.

The exact sizes and counts on your machine will differ. The useful part is the shape of the system.

I expected Cursor to have one obvious "session log" folder, the way Claude Code has `~/.claude/projects/*.jsonl`.

It doesn't.

What I found instead was a layered system:

- SQLite chat databases in `~/.cursor/chats/`
- transcript JSONL files in `~/.cursor/projects/.../agent-transcripts/`
- a massive global state database at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- workspace state DBs, local file history, checkpoint diffs, and even separate AI-tracking tables on top of that

If you're building tooling on top of Cursor session data, this matters. If you're just curious where your chats went, it matters even more.

---

## Where are Cursor sessions actually stored?

On this machine, Cursor session data is spread across **three primary sources**.

### 1. `~/.cursor/chats/*/*/store.db`

This is the cleanest "real chat database" layer.

I found **171** local `store.db` files under `~/.cursor/chats/`, totaling about **280 MB** of actual SQLite payload.

A recent one on my machine has:

- tables: `meta`, `blobs`
- 1 `meta` row
- **835** blob rows
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
  "agentId": "d5c2d589-344b-4f62-a091-af4701f742ce",
  "name": "Cursor Session TTL",
  "mode": "auto-run",
  "lastUsedModel": "gpt-5.4-high"
}
```

This is not "some cache." It's a real local conversation store.

### 2. `~/.cursor/projects/*/agent-transcripts/*.jsonl`

This is the most Claude-like layer.

I found:

- **138** transcript JSONL files
- **17** `agent-tools/*.txt` sidecar files

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

On my machine, `state.vscdb` alone is **1.24 GB**.

And it doesn't just hold preferences. It holds large volumes of chat/composer state in a key-value table called `cursorDiskKV`.

Here are the biggest key families I found:

| Prefix | Count | Approx size |
|--------|-------|-------------|
| `agentKv` | 88,826 | **506.5 MB** |
| `bubbleId` | 55,889 | **463.9 MB** |
| `composerData` | 1,188 | **45.4 MB** |
| `checkpointId` | 5,842 | **42.5 MB** |
| `messageRequestContext` | 1,786 | **23.8 MB** |

So if you were imagining "Cursor stores some chats locally," undersell that by a lot. Cursor stores a **huge amount of local state**, and much of it is not in tidy text logs.

One important nuance: not every big key family here is equally useful for replay.

- `composerData` and `bubbleId` are the most obviously replay-relevant
- `messageRequestContext` looks more like prompt-building context snapshots
- `checkpointId` looks like restore / inline-diff state
- `agentKv` appears to be a separate message/blob store that is often tagged with request IDs

One subtle thing I learned after a deeper pass: `messageRequestContext:<uuid>:<uuid>` does appear to share its **first** UUID with `composerData` / checkpoint session IDs, so this layer is probably best understood as a per-session context sidecar rather than random junk.

---

## Cursor doesn't have one transcript format. It has a local storage stack.

This is the most important difference from Claude Code.

With Claude Code, the mental model is:

```text
session = one JSONL file
```

With Cursor, the practical model is closer to:

```text
session = SQLite chat store + global composer state + bubble state + optional transcript JSONL + tool sidecars + workspace UI state
```

That complexity is exactly why tools like [vibe-replay](https://github.com/tuo-lei/vibe-replay) have to merge multiple Cursor sources instead of just reading one folder.

---

## What is inside `composerData` and `bubbleId`?

The replayable part of Cursor's global state is organized like this:

- `composerData:<session-id>`
- `bubbleId:<session-id>:<bubble-id>`

Not every `composerData:*` row is replayable. Some are more like summaries or stale state blobs. The key field is `fullConversationHeadersOnly`.

When that array is populated, you effectively get the bubble list for a session.

One replayable sample on my machine looked like this:

```json
{
  "name": "Checking Retool Version on Helm",
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

Here's a real tool bubble I found:

```json
{
  "name": "run_terminal_cmd",
  "params": "{\"command\":\"helm list -n retool | cat\",\"requireUserApproval\":true}",
  "userDecision": "rejected",
  "result": "{\"rejected\":true}"
}
```

So Cursor isn't just storing "messages." It's storing structured traces of what the agent tried to do.

---

## How much of Cursor's behavior is visible locally?

More than I expected, but in a fragmented way.

### Token counts

I found bubble payloads with token snapshots like:

```json
{
  "inputTokens": 41263,
  "outputTokens": 4901
}
```

That's enough to do best-effort token and cost estimation for some Cursor sessions.

### Timing

I also found fields like:

```json
{
  "thinkingDurationMs": 21322
}
```

So Cursor does expose some local timing signals. They just aren't sitting in one neat append-only log.

### File context

Some bubbles included:

- `relevantFiles`
- `recentlyViewedFiles`

That means Cursor's local state sometimes preserves its own context-building breadcrumbs, which is fascinating if you're trying to understand what the model saw.

### Request-level message blobs

The biggest family in `state.vscdb` is actually `agentKv`, not `composerData`.

On this machine, I decoded over **32,000** readable `agentKv:blob:*` payloads. They look like structured message objects with:

- `role`
- `content`
- sometimes `providerOptions.cursor.requestId`

The important takeaway is not the exact row count. It is that Cursor appears to keep a request-level message/blob archive with assistant text, tool traffic, reasoning blocks, and injected context wrappers like `<user_query>` and `<open_and_recently_viewed_files>`.

I would not treat `agentKv` as the main replay source yet. But it is strong evidence that Cursor stores more than just transcript text and chat summaries.

---

## Does Cursor keep a prompt history?

Yes, but not in the same way Claude Code does.

I found:

```bash
~/.cursor/prompt_history.json
```

On this machine:

- size: **223 KB**
- entries: **500**
- payload shape: plain strings

That is important because it suggests **Cursor keeps a rolling prompt history locally**, but it does **not** look like Claude Code's rich `history.jsonl` global index with timestamps, project paths, and session IDs on every row.

So the safe statement is:

- Cursor stores local prompt history.

The unsafe statement is:

- Cursor stores a complete structured cross-project prompt log equivalent to Claude Code.

I don't think the evidence supports that stronger claim yet.

---

## Can you recover files Cursor changed?

Partially, yes.

Cursor's docs say [Agent checkpoints are stored locally and are separate from Git](https://cursor.com/docs/agent/chat/checkpoints). My machine backs that up.

I found local checkpoint artifacts here:

```text
~/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-commits/checkpoints/
```

On my machine:

- **9** checkpoint directories
- **87** files
- total size: **1.04 MB**

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

There is also a **separate** recovery system:

```text
~/Library/Application Support/Cursor/User/History/
```

That's VS Code-style local file history, not AI chat history.

On this machine:

- **640** `entries.json`
- **5,162** total files

So if you're asking "can I recover what the AI touched?", the answer is:

- maybe from Cursor checkpoints
- maybe from VS Code local history
- maybe from Git

But unlike Claude Code, those answers are split across multiple systems.

---

## Cursor also keeps a separate AI tracking database

This was the most surprising "extra" database I found:

```text
~/.cursor/ai-tracking/ai-code-tracking.db
```

On my machine it's about **14.7 MB**, and it has tables like:

- `ai_code_hashes`
- `scored_commits`
- `tracked_file_content`
- `ai_deleted_files`
- `tracking_state`

This does **not** look like the main chat/session database. It looks more like Cursor's internal AI-attribution and provenance system.

The two most revealing tables were:

- `ai_code_hashes`, with **about 42k** rows linking hashes to sources like `cli` and `composer`
- `scored_commits`, with **1,071** rows and fields like:

- `commitHash`
- `branchName`
- `tabLinesAdded`
- `composerLinesAdded`
- `humanLinesAdded`
- `v1AiPercentage`
- `v2AiPercentage`

In other words: Cursor appears to keep a local database specifically for tracking AI-touched code and commit-level attribution.

I also found that `ai_code_hashes.conversationId` overlaps real `composerData` session IDs in many cases on this machine, which suggests this attribution layer is not fully separate from Cursor's session model.

That is a very different kind of local artifact from a replay log, so I would treat it as a secondary storage layer, not "where the chats are."

---

## Does Cursor auto-delete old sessions?

I could not find evidence of a fixed local TTL like Claude Code's default 30-day cleanup behavior.

On this machine:

- `store.db` files older than 30 days: **61**
- local history entries go back to **2025-02-06**
- workspace state DBs also persist far beyond 30 days

That does **not** prove Cursor never cleans anything up. But it does strongly suggest there is no simple "all sessions expire after 30 days" rule visible in local storage.

The public docs I found are much stronger on privacy, checkpoints, usage, and cloud sharing than on local retention policy.

---

## What about workspace state?

There are also **97** workspace DBs here:

```text
~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb
```

The newest one on my machine contains keys like:

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

If I had to answer in one sentence:

**Cursor's equivalent is a storage system, not a transcript directory.**

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

That is the map I wish I had before I started reverse-engineering Cursor session replay.

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

It already knows how to merge Cursor's JSONL, SQLite, and global-state layers into a replayable session view.

Cursor stores a lot more locally than its UI reveals.

That is the headline.

The deeper point is that Cursor's local footprint is not one transcript directory you can casually inspect. It is a stack of overlapping systems for replay, recovery, request context, and attribution.

Once you look at it that way, the scattered files start to make sense.

