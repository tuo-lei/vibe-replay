---
title: "Claude Code's Source Leaked. We Read It and Shipped 6 Features in a Day."
excerpt: "513,000 lines of TypeScript, extracted from a source map left in the npm package. We found undocumented JSONL fields, hidden metadata, and MCP tool naming conventions — then turned them into product improvements."
date: 2026-04-01
readTime: "7 min read"
---

On March 31, 2026, security researcher [Chaofan Shou](https://x.com/Fried_rice) discovered that Anthropic had shipped a source map file inside the published `@anthropic-ai/claude-code` npm package. The `cli.js.map` file contained the `sourcesContent` of every original TypeScript file — 1,987 files, 513,000 lines of code, trivially extractable.

Within hours, multiple GitHub repositories had the full source. Anthropic acknowledged it and subsequently made the code available in the public domain.

We build [vibe-replay](https://github.com/tuo-lei/vibe-replay), a tool that parses Claude Code's JSONL session files and turns them into interactive replays. We'd been reverse-engineering the JSONL format from observed data for months. Now we had the actual source of truth.

We cloned the repo, read the code, and started shipping. Here's what we found and what we built.

---

## What the source revealed

Claude Code's session format is far richer than what you see in the terminal. Every line in a `.jsonl` file is a typed `Entry` — and there are over 20 distinct entry types, most undocumented.

Before the leak, we knew about the obvious ones: `user`, `assistant`, `system`, `progress`, `custom-title`, `pr-link`. After reading `src/types/logs.ts`, we discovered entries like `attribution-snapshot`, `marble-origami-commit` (an obfuscated name for context collapse), `speculation-accept`, `worktree-state`, `agent-setting`, and more.

But the most useful discoveries weren't new entry types — they were **undocumented fields on existing messages** that we'd been ignoring.

---

## Discovery 1: `isCompactSummary` — a flag we were guessing at

When Claude Code runs out of context, it compacts the conversation into a summary. The compaction summary is a user-role message that starts with "This session is being continued from a previous conversation..."

We'd been detecting this with a string prefix match. Fragile — if Anthropic ever changed the wording, our detection would silently break.

The source revealed that every compaction summary message carries `isCompactSummary: true` as a top-level field. A reliable, future-proof flag that was sitting in the data all along.

We now use the flag as the primary detection, with the string prefix as a fallback for older sessions.

---

## Discovery 2: `isMeta` — invisible messages that were leaking into replays

This was a bug we didn't know we had.

Claude Code injects system messages into the conversation that are invisible in the terminal UI. These `isMeta: true` messages include skill injections ("Base directory for this skill: ..."), local command caveats, and slash command outputs.

Our parser was treating them as regular user turns. In replays, they'd show up as mysterious user prompts with XML tags or skill configuration text that the user never actually typed.

After reading the source, we understood the taxonomy:

| `isMeta` pattern | Frequency | Value |
|---|---|---|
| `<local-command-caveat>` | 108 | Low — just a wrapper telling the model to ignore |
| Skill injection (`Base directory for this skill:`) | 14 | High — shows which skills were activated |
| `/insights` output | 1 | High — slash command data |
| Image injection metadata | 6 | Medium |

We now classify each `isMeta` message and handle them differently:
- **Skill injections** become `context-injection` scenes with a specific label like "Skill: playwright-cli" — visible in the replay with blue styling, distinct from user prompts
- **Slash command outputs** get labeled "Command: /insights"
- **Low-value caveats** (local-command wrappers) are filtered out entirely — they added noise without insight

We also extract the skill names into a `skillsUsed` metadata field. In the dashboard, sessions now show skill badges:

```
[claude-opus-4-6] [cli] [playwright-cli]
```

---

## Discovery 3: `stop_reason` — detecting truncated responses

Every assistant message in the JSONL carries a `stop_reason` field: `end_turn`, `tool_use`, or `max_tokens`.

We'd never looked at it. But `max_tokens` means Claude's response was cut off mid-sentence — important context that was invisible in replays.

We now track this per-message and surface it:
- `ParsedTurn` gets a `stopReason: "max_tokens"` field
- Text response scenes get an `isTruncated` flag
- The viewer shows a small "Response truncated (max_tokens reached)" indicator
- Session metadata includes `truncatedResponses` count

Across all sessions on one test machine, we found 211 truncated responses — far more than we expected.

---

## Discovery 4: MCP tool naming convention

This one came from reading `src/services/mcp/mcpStringUtils.ts`. MCP (Model Context Protocol) tools follow a strict naming convention:

```
mcp__<server_name>__<tool_name>
```

For example: `mcp__claude-in-chrome__tabs_context_mcp`, `mcp__playwright__navigate`.

Before the leak, these names rendered verbatim in replays — long, ugly, and hard to parse visually. Now we:

1. **Detect MCP tools** by the `mcp__` prefix
2. **Extract server names** into `mcpServersUsed` metadata (shown as purple badges in the dashboard)
3. **Format display names** as `server · tool` (e.g., "claude-in-chrome · navigate")
4. **Use a plug icon** instead of the generic gear for MCP tools

On one test machine, 20+ sessions used MCP tools with 1,036 total calls — primarily `claude-in-chrome` (454 calls) and `playwright` (16 calls).

---

## Discovery 5: `service_tier` and pricing validation

The `usage` object on assistant messages includes a `service_tier` field (e.g., `"standard"`) that we'd been ignoring. We now extract it as session metadata.

More importantly, the source at `src/utils/modelCost.ts` contains the exact pricing tiers:

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| Opus 4.6/4.5 | $5/Mtok | $25/Mtok | $6.25/Mtok | $0.50/Mtok |
| Opus 4/4.1 | $15/Mtok | $75/Mtok | $18.75/Mtok | $1.50/Mtok |
| Sonnet 4/4.5/4.6 | $3/Mtok | $15/Mtok | $3.75/Mtok | $0.30/Mtok |
| Haiku 4.5 | $1/Mtok | $5/Mtok | $1.25/Mtok | $0.10/Mtok |
| Opus 4.6 fast mode | $30/Mtok | $150/Mtok | $37.50/Mtok | $3.00/Mtok |

We validated our cost estimation against these exact numbers. The Sonnet 4 (non-4.5/4.6) model had been falling through to a generic rate — we added an explicit entry matching Claude Code's `COST_TIER_3_15`.

---

## What's left to explore

The source revealed far more than we could ship in a day. Here's what we documented for future work:

**Data that exists but we haven't seen in the wild yet:**
- `api_metrics` system messages with TTFT (time to first token) and tokens/sec
- `attribution-snapshot` entries with character-level AI contribution tracking per file
- `speculation-accept` entries showing time saved by speculative execution
- `worktree-state` entries for git worktree isolation sessions
- `marble-origami-commit` (context collapse) events

**Viewer features that need larger work:**
- Context window utilization curve overlaid on the timeline (the data is already in `turnStats.contextTokens`)
- Conversation tree visualization using `parentUuid` chains
- Coordinator/worker multi-agent visualization for `CLAUDE_CODE_COORDINATOR_MODE` sessions

---

## The meta observation

We've been parsing Claude Code's JSONL output for months, treating it as an opaque format that we reverse-engineered from observed data. The source leak let us validate every assumption — and found several wrong ones.

The `isMeta` bug is a good example: we'd never noticed the skill injection messages leaking into replays because they were rare and looked vaguely plausible. Without the source telling us that `isMeta: true` marks system-injected content, we might never have caught it.

The full implementation is across two PRs: [#116](https://github.com/tuo-lei/vibe-replay/pull/116) (parser improvements, context-injection scenes, skill detection) and [#119](https://github.com/tuo-lei/vibe-replay/pull/119) (MCP server detection, tool name display). Both are merged.

If you want to see these improvements in action, install vibe-replay and run `vibe-replay -d` to open the dashboard — sessions with skills and MCP tools will now show the new badges and labels.

```bash
npx vibe-replay -d
```
