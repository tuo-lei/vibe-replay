---
title: "Capturing Claude's Autonomous Agent Mode: A Deep Dive into Dispatch"
excerpt: "I let Claude plan a 6-hour Japan trip in Cowork mode. Then I tried to replay it — and vibe-replay couldn't see the session at all. Here's what it took to fix that."
cover: "/blog/dispatch-deep-dive/dashboard.png"
date: 2026-04-25
readTime: "8 min read"
---

I let Claude plan a Japan spring break trip in autonomous mode. 6 hours, 125 prompts, 364 tool calls — Gmail searches, browser sessions, calendar checks, all chained together while I went about my day. When I came back, I wanted to replay it.

vibe-replay couldn't see the session.

[![Cowork session landing page showing 'A Claude Cowork session replay by vibe-replay' — 125 turns, $71.07 cost](/blog/dispatch-deep-dive/cowork-landing.png)](/blog/dispatch-deep-dive/cowork-landing.png)

It now can. This is what it took.

---

## Two Claudes in one app

Claude Desktop is actually two AI experiences sharing a window. The **Code tab** is Claude Code in a managed wrapper — the same CLI, the same JSONL transcripts, the same tool calls you'd see in your terminal. The **Cowork tab** is something else entirely: an autonomous agent mode where Claude runs in an isolated sandbox VM, orchestrates multi-step plans on its own, and writes its transcript to a completely different place on disk.

Anthropic internally calls the orchestrator behind Cowork **Dispatch** — and the name fits. Each Cowork session spins up a sandboxed VM with a codename like `hopeful-awesome-feynman` or `zealous-wonderful-meitner`, mounts your real folders into a fake filesystem rooted at `/sessions/{processName}/`, and writes its full audit trail into:

```
~/Library/Application Support/Claude/local-agent-mode-sessions/.../audit.jsonl
```

That's nowhere near `~/.claude/projects/`, which is what vibe-replay had been scanning since day one.

That's the surface answer to "why couldn't it see the session." But once I started reading audit files, two deeper things mattered.

---

## Discovery 1: Cowork transcripts are self-contained

Claude Code's storage layout has a small but consequential split. Metadata lives in one place; the transcript lives in another, joined by an ID:

```
~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl   ← transcript
~/Library/.../claude-code-sessions/.../local_{id}.json   ← metadata, with cliSessionId pointing back to the JSONL
```

To replay a Code-tab session, you read the metadata, follow the pointer, and find the JSONL — which means re-implementing Claude's "encode cwd by replacing `/` with `-`" path scheme. Brittle, but solvable.

Cowork chose a different shape:

```
~/Library/.../local-agent-mode-sessions/{accountId}/{orgId}/
├── local_{id}.json     ← metadata (title, model, initialMessage)
└── local_{id}/
    └── audit.jsonl     ← full transcript, right next door
```

No cross-references. No path encoding tricks. The transcript sits next to its metadata in a sibling directory. This is the kind of design choice that probably saved its authors a week of debugging — and it lets vibe-replay treat each Cowork session as a single self-contained unit, no matter what sandbox it ran in or what codename it got.

---

## Discovery 2: the `cliSessionId` trap

Cowork sessions also carry a `cliSessionId` field. The name is suggestive — exactly the kind of thing you'd grab as a dedup key without thinking.

Don't.

The `cliSessionId` in a Cowork session is the UUID of the **inner Claude Code subprocess running inside the sandbox VM** — a completely separate process from the one writing the audit trail you're reading. It doesn't appear anywhere on the outer audit records. Treat it as the session's identity and you'll permanently break replay-to-source linking: every time the sandbox restarts that inner CLI, the "same" session gets a new ID.

The right key is the metadata's `sessionId` field (with the `local_` prefix stripped). That's the stable, outer-loop identity of the Cowork session itself.

I learned this the long way. Future me, reading this post, gets to skip that.

---

## Three providers, one discovery pass

With those two insights, the rest of the implementation falls out:

- **`claude-code`** scans `~/.claude/projects/` for raw JSONL files. The original provider.
- **`claude-desktop`** reads metadata from the Code tab's location, follows `cliSessionId` to `~/.claude/projects/` to find the actual JSONL, and overlays Desktop's richer metadata (title, exact model, permission mode) on top.
- **`claude-cowork`** reads metadata from the autonomous-mode location and goes straight to the co-located audit.jsonl. No path resolution required — that's discovery 1 paying off.

All three run in parallel and produce a flat list of sessions.

Parallel discovery introduces a collision: the same Code-tab JSONL gets found twice — once raw by `claude-code`, once with metadata by `claude-desktop`. Both providers correctly assign the same `sessionId` to it. Dedup just keeps the best-quality record using a fixed priority:

```
claude-cowork → claude-desktop → claude-code → cursor
```

`claude-desktop` wins over `claude-code` because it has the title and model that the Desktop UI inferred. `claude-cowork` ranks first because its transcript is authoritative. `cursor` uses a different ID scheme entirely, so it never collides with the Claude family.

---

## What replay looks like now

A Cowork session in the player:

[![The replay player showing the Japan trip planning session — prompt outline on left, conversation in center, tool use tags visible](/blog/dispatch-deep-dive/cowork-player.png)](/blog/dispatch-deep-dive/cowork-player.png)

Left panel: outline of every user prompt — useful when there are 125 of them. Center: the conversation, with tool-use tags inline. The MCP toolkit Cowork exposes (`gmail_read_message`, `AskUserQuestion`, `navigate`, `Claude_in_Chrome`) shows up as recognizable tool tags instead of raw `mcp__workspace__*` strings.

Code-tab sessions running through Desktop pick up extra metadata the raw JSONL never sees — the human-readable title Desktop inferred, the permission mode, the git worktree branch:

[![Claude Desktop session landing showing 'A Claude Desktop session replay' with worktree branch and dangerous mode badge](/blog/dispatch-deep-dive/desktop-session-landing.png)](/blog/dispatch-deep-dive/desktop-session-landing.png)

(That session is literally the implementation of the Cowork provider itself. The first prompt: *"Add support for Cowork (Dispatch) sessions to vibe-replay…"* The `dangerous mode` badge and `claude/crazy-ishizaka-06a286` branch name come from Desktop's metadata.)

And the dashboard ties it all together:

[![vibe-replay dashboard: 279 sessions — Claude Code 224, Claude Cowork 47, Cursor 6, Claude Desktop 2, plus activity heatmap](/blog/dispatch-deep-dive/dashboard.png)](/blog/dispatch-deep-dive/dashboard.png)

279 sessions across all four providers. The badges (`CLAUDE`, `COWORK`, `DESKTOP`) are how you tell them apart at a glance:

[![Sessions list showing CLAUDE, COWORK, and DESKTOP provider badges](/blog/dispatch-deep-dive/sessions-list.png)](/blog/dispatch-deep-dive/sessions-list.png)

---

## Try it

If you've used Cowork at all, you have audit files sitting on disk right now:

```bash
npx vibe-replay
```

Auto-discovery picks up everything — Code, Desktop, Cowork, Cursor. Pick a session, get a self-contained HTML file in `~/.vibe-replay/{sessionId}/index.html`.

Or surface them all at once:

```bash
npx vibe-replay --dashboard
```

A few things still ahead: linking Dispatch's child sub-agents back to their parent session, surfacing richer MCP context (which server, which operation) in the player, and a unified timeline across long autonomous runs.

But the foundation is in place. Every audit.jsonl Claude produces — Code, Desktop, Cowork — is now fair game.

---

*vibe-replay is open source. The providers discussed here landed in [PR #187](https://github.com/tuo-lei/vibe-replay/pull/187).*
