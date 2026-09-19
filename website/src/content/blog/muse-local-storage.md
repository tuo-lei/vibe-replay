---
title: "What Does Muse Store Locally? Agent Session JSONL Explained"
excerpt: "Muse keeps one JSONL per agent under ~/agents — with session_header/item/compaction_checkpoint records, thinking as a first-class citizen, and a source field on every line naming the runtime subsystem that wrote it."
cover: "/blog/muse-storage/storage-map.png"
date: 2026-09-18
readTime: "7 min read"
---

Claude Code keeps sessions under `~/.claude/`. Cursor spreads them across SQLite and JSONL. Grok Bot keeps them on a cloud box. Muse is simpler than all three: **one JSONL per agent, on your own disk** — `~/agents/<agent-id>/sessions/<agent-id>.jsonl`, append-only, no database. The twist is that the runtime **signs every line it writes**: each item record carries a `source` field like `runtime.feed`, `runtime.self_improvement`, or `scheduler.cron`, naming the subsystem that produced it.

**Try it:** `npx vibe-replay@latest -p muse`. Or open the full dashboard with `npx vibe-replay@latest -d`.

Here's where the files live, how the schema works, and what vibe-replay rewrites so the replay matches the session you actually lived. All numbers below come from a real census: 471 agent sessions, 11,667 lines, zero malformed.

The practical mental model is:

```text
~/agents/<agentId>/sessions/<agentId>.jsonl   ← one file per agent, append-only
~/agents/<agentId>/sessions/sessions.json     ← runtime index (best-effort)
```

![Diagram of Muse local session storage layout](/blog/muse-storage/storage-map.png)

vibe-replay discovers those JSONL files, pairs tool calls with their outputs, promotes thinking blocks, filters runtime noise, and renders the result as the same replay format used for other providers.

## Where the files live

Sessions default to:

```text
~/agents/<agentId>/sessions/<agentId>.jsonl
```

Layout rules that matter for tooling:

| Path piece | Meaning |
| --- | --- |
| `<agentId>/` | One folder per agent; the filename repeats the agent id |
| `<agentId>.jsonl` | Append-only conversation log, one JSON object per line |
| sibling `sessions.json` | Runtime index: `created_at`/`updated_at`, `item_count`, `compaction_count`, `context_window_usage.model_id` |

Point discovery at a different root with one env var:

```bash
MUSE_AGENTS_DIR=/path/to/agents npx vibe-replay@latest -p muse
```

## The JSONL shape

Three record types at the top level:

| Record | Share of 11,667 lines | Meaning |
| --- | --- | --- |
| `item` | 11,182 | Everything: messages, thinking, tool calls and outputs |
| `session_header` | 471 | One per file: `session_id`, `agent_id`, `created_at` |
| `compaction_checkpoint` | 15 | Context compaction marker (metadata only) |

Inside `item` records, the `type` field tells you what you're looking at:

- `function_call` (3,275) / `function_call_output` (3,274) — tool calls and their results, paired by `call_id`
- `thinking` (2,783) — the model's private reasoning, a first-class record
- `message` (1,283) — user / assistant / developer turns
- `commentary_text` (537) — short status narration between tool calls
- `message_parts` (30) — multi-part message fragments

Roles are the familiar three — `user` (820), `assistant` (392), `developer` (101) — but the role alone doesn't tell you who wrote a line. The `source` field does.

## Source provenance: the runtime signs its work

This is the most unusual thing about the Muse format, and the reason the provider was fun to build. Every item record carries `source`, a dotted name for the runtime subsystem that emitted it. From the census:

| Source | Lines | What it is |
| --- | --- | --- |
| `runtime.feed` | 4,898 | The main agent loop |
| `runtime` | 3,525 | Core runtime |
| `runtime.self_improvement` | 2,503 | Background self-improvement passes |
| `scheduler.cron` | 167 | Scheduled cron runs |
| `runtime.monitoring` | 19 | Monitoring injections |
| `runtime.injected_context_change` | 16 | Context updates pushed mid-session |
| `runtime.tool_guidance` | 8 | Tool-use guidance |
| `runtime.skill_invalidation` | 14 | Skill cache invalidations |
| `runtime.subagent_progress` / `runtime.subagent_monitor` | 14 | Subagent lifecycle |
| `runtime.dev_notice`, `runtime.onboarding`, `runtime.merge_notice`, `runtime.todo_snapshot`, `runtime.background_exec` | ~20 | Notices, onboarding, todos, background work |

vibe-replay uses `record.source` — not text sniffing — to decide what the runtime injected versus what the conversation actually was. A parser that only looks at roles would show you developer instructions and hidden wakes as if they were chat. The source field makes the distinction structural.

## Thinking is a first-class citizen

2,783 thinking blocks out of 11,667 lines — nearly **one in four lines** is the model reasoning with itself. Muse doesn't hide its scratch work in an undocumented field; `thinking` is a top-level item type. vibe-replay renders these as thinking scenes in the replay, so you can watch the agent change its mind.

## What gets filtered

Three things never make the replay:

1. **`developer` messages** (101) — runtime instructions with sources like `runtime.dev_notice` and `runtime.onboarding`. They're addressed to the model, not part of your conversation.
2. **Compaction summaries** — the 15 `compaction_checkpoint` records are kept as metadata (timestamp and trigger), but the summary blob itself is not replayed. It's a compressed memory of everything before the checkpoint — replaying it would surface distilled context the session itself never showed.
3. **`[Subagent Context]`-prefixed injections** — context handed to subagents, skipped for titles and first prompts.

## Tool names need a map

On disk, tools show up as lowercase implementation names: `exec`, `read`, `write`, `edit`, `browser_search`, `context_fetch`, `memory_search`. The replay viewer expects canonical names (`Bash`, `Read`, `Write`, `Edit`, …) to build shell and diff scenes, so the provider normalizes names and remaps arguments — `exec` → `Bash`, `read` → `Read`, and so on. Unrecognized names (future builtins, MCP tools) pass through unchanged. Each `function_call` is paired with its `function_call_output` by `call_id` into a single tool-use block with result/error flags.

The most-called tools in the census read like a week of real agent life: `exec` (875), `read` (465), `finish_step` (313), `write` (181), `browser_search` (168), `browser_open` (160), `edit` (147).

## Try it

```bash
npx vibe-replay@latest -p muse
```

Or open the full dashboard:

```bash
npx vibe-replay@latest -d
```

Muse is a good reminder that the interesting part of a transcript format isn't the container — JSONL is JSONL — it's the **provenance model**. One file per agent, no SQLite, no cloud round-trip, and every line stamped with the name of the subsystem that wrote it. Once you model the source field, thinking blocks, and the call/result pairing, the replay matches the session instead of the raw log.

For comparison, see the cloud-box JSONL of [Grok Bot](/blog/grok-bot-local-storage/) and [Hermes's profile-aware `state.db`](/blog/hermes-local-storage/).

## Related

- [PR #630 — native `provider-muse`](https://github.com/tuo-lei/vibe-replay/pull/630)
- [vibe-replay.com](https://vibe-replay.com/)
- Earlier in this series: [Claude Code](/blog/claude-code-local-storage/), [Cursor](/blog/cursor-local-storage/), [Codex](/blog/codex-local-storage/), [Cowork](/blog/dispatch-deep-dive/), [Pi](/blog/pi-local-storage/), [OpenCode](/blog/opencode-local-storage/), [Hermes](/blog/hermes-local-storage/), [Grok Bot](/blog/grok-bot-local-storage/)
