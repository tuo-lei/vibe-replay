---
title: "What Does Grok Bot Store Locally? agent-transcripts JSONL Explained"
excerpt: "Grok Bot keeps each agent session as cloud-box JSONL under agent-transcripts — with send_message as the visible reply, hidden prompts filtered, and group wakes split by speaker."
cover: "/blog/grok-bot-storage/storage-map.png"
date: 2026-09-04
updated: 2026-09-04
readTime: "7 min read"
---

Claude Code keeps sessions under `~/.claude/`. Cursor spreads them across SQLite and JSONL. Grok Bot is different: the durable chat history lives on the **cloud box**, not your Mac — one JSONL per agent, with a twist that user-visible replies are a tool call.

Here's where the files live, how the schema works, and what vibe-replay has to rewrite so a replay matches the chat you actually saw.

The practical mental model is:

```text
/home/box/agent-data/agent-transcripts/<agentId>/<agentId>.jsonl
        │
        ├── optional sand-data symlink / ~/.grok-bot export
        └── sibling agents/<id>/profile.json  → titles
```

![Diagram of Grok Bot agent-transcripts layout](/blog/grok-bot-storage/storage-map.png)

vibe-replay discovers those JSONL files, rewrites hidden wakes and `send_message` replies, and renders the result as the same replay format used for other providers.

## Where the files live

On the box, transcripts default to:

```text
/home/box/agent-data/agent-transcripts/<agentId>/<agentId>.jsonl
```

`agent-data` often symlinks into `sand-data`, so you may also see:

```text
/home/box/sand-data/agent-transcripts/<agentId>/<agentId>.jsonl
```

Layout rules that matter for tooling:

| Path piece | Meaning |
| --- | --- |
| `<agentId>/` | One folder per agent (or `sand-subagent-<uuid>/` for background workers) |
| `<agentId>.jsonl` | Append-only conversation log |
| sibling `agents/<id>/profile.json` | Display name / cwd when present — used for titles |

There is no macOS Application Support path for these sessions. If you copy transcripts off the box, the documented drop spot is `~/.grok-bot/agent-transcripts` with the same `<id>/<id>.jsonl` layout.

Point discovery at a copy with either env var (Pi-style override — replaces the defaults):

```bash
GROK_BOT_TRANSCRIPTS_DIR=/path/to/agent-transcripts npx vibe-replay -p grok-bot
# or
VIBE_REPLAY_GROK_BOT_DIR=/path/to/agent-transcripts npx vibe-replay -p grok-bot
```

SSH remote indexing of Grok Bot transcripts is not included yet.

## The JSONL shape

One JSON object per line:

```json
{"role":"user"|"assistant"|"tool","message":{"content":[...]}}
```

Content blocks look familiar if you've read Claude-style tool transcripts:

- `text` — string payload
- `tool_use` — `{ name, input, toolCallId? }`
- `tool_result` — lives on **`role: "tool"` lines**, not nested under the next user turn

That last point is easy to miss. A Claude Code parser that only looks for tool results inside subsequent user messages will drop Grok Bot results on the floor.

Timestamps are sparse at the top level. When `send_message` (or other tools) return `result.success.timestamp` as epoch milliseconds, vibe-replay synthesizes ISO times from those; otherwise discovery falls back to file mtime. v1 does not surface thinking blobs.

## Hidden prompts vs what you saw in chat

Two layers of text never appear the same way in the Grok Bot UI:

1. **`[SAND_HIDDEN_PROMPT]…`** — system wakes (first-run cues, routine fires, agent-to-agent resumes). Skip them for replay; they are instructions to the model, not chat.
2. **Assistant `text` blocks** — private scratch. The model reasons here; the user does not see it as a bubble.

What you *do* see in the app is almost always a **`send_message` tool call**. vibe-replay's Grok Bot provider promotes `input.text.content` into a normal assistant text scene and **does not** emit `send_message` as a tool-call beat. That single rewrite is why the replay feels like the product instead of like a tool dump.

User turns often arrive with delivery tags such as `[t0u]` / `[t3u]`. Those prefixes are stripped before display.

## Tool names need a map

On disk, builtins show up as lowercase implementation names: `read`, `shell`, `web_fetch`, `todo`. The replay viewer expects canonical names (`Read`, `Bash`, `WebFetch`, `TodoWrite`) to build diffs and shell scenes. Unrecognized names (future builtins, MCP) pass through unchanged.

## Subagents are separate sessions (for now)

Folders named `sand-subagent-<uuid>/` are discovered as **their own sessions**. v1 does not stitch them under a parent agent.

## Group chats: split speakers, still per-agent

A group turn still lands as ordinary `role:"user"` text starting with `[Group chat:` — and it's still written into **each participating agent's** own JSONL. As of [PR #546](https://github.com/tuo-lei/vibe-replay/pull/546), vibe-replay splits that blob into:

1. A room header (`subtype: "context-injection"`) with title, participants, and `@` mentions
2. One user turn per `Speaker: message`, in order (rendered with a `**Speaker:**` prefix)

Procedural noise is dropped: `It's your turn…`, `The room is wrapping up…`, `No new messages in the room…`.

When any group payload is seen, the session title becomes `Group: <room title>`. Discovery can also pull the title from recent wakes or sibling `agents/<id>/group.json`.

What v1 still does **not** do: merge Eng's and GTM's transcripts into one shared HTML timeline. You replay each agent's view of the room.

[Watch a real Grok Bot group session](https://vibe-replay.com/view/?gist=7edc281ec73e164379b8792eb185817e) to see that split: English, per-speaker turns after [#546](https://github.com/tuo-lei/vibe-replay/pull/546), still one agent's view of the room ([gist](https://gist.github.com/tuo-lei/7edc281ec73e164379b8792eb185817e)).

## Try it

```bash
npx vibe-replay -p grok-bot
```

Or open the full dashboard:

```bash
npx vibe-replay -d
```

Grok Bot is a good reminder that JSONL does not automatically mean “linear Claude-style chat.” The durable truth is a cloud-box transcript whose visible replies are a tool call, with hidden wakes filtered out and group rooms split by speaker — still one file per agent, not a shared timeline. Once you model those rewrites, the replay matches the product instead of the raw log.

For comparison, see the JSONL tree used by [Pi coding agent](/blog/pi-local-storage/) and [Hermes’s profile-aware `state.db`](/blog/hermes-local-storage/).

## Related

- [PR #544 — native `provider-grok-bot`](https://github.com/tuo-lei/vibe-replay/pull/544)
- [PR #546 — group wake speaker split](https://github.com/tuo-lei/vibe-replay/pull/546)
- [Example replay — Grok Bot group session](https://vibe-replay.com/view/?gist=7edc281ec73e164379b8792eb185817e)
- [vibe-replay.com](https://vibe-replay.com/)
- Earlier in this series: [Claude Code](/blog/claude-code-local-storage/), [Cursor](/blog/cursor-local-storage/), [Codex](/blog/codex-local-storage/), [Cowork](/blog/dispatch-deep-dive/), [Pi](/blog/pi-local-storage/), [OpenCode](/blog/opencode-local-storage/), [Hermes](/blog/hermes-local-storage/)
