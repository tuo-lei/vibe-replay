---
title: "Capturing Claude's Autonomous Agent Mode: A Deep Dive into Dispatch"
excerpt: "vibe-replay now captures Claude Desktop sessions — both the Code tab and Cowork's autonomous Dispatch mode. Here's how three different providers discover, deduplicate, and replay every session type Claude produces."
cover: "/blog/dispatch-deep-dive/dashboard.png"
date: 2026-04-25
readTime: "8 min read"
---

[![vibe-replay dashboard showing 279 sessions across Claude Code, Claude Cowork, Cursor, and Claude Desktop providers](/blog/dispatch-deep-dive/dashboard.png)](/blog/dispatch-deep-dive/dashboard.png)

When you open Claude Desktop, you get two very different AI experiences. The **Code tab** is Claude Code running in a managed environment — the same CLI, the same JSONL transcripts, same tool calls you'd see in your terminal. The **Cowork tab** is something else entirely: an autonomous agent mode where Claude runs in an isolated sandbox VM, orchestrates multi-step plans on your behalf, and writes its transcript into a completely different location on disk.

vibe-replay now captures both. This post covers the architecture that makes it work.

---

## What is Dispatch?

When Claude Desktop runs in Cowork (autonomous agent) mode, it operates what Anthropic internally calls **Dispatch** — an orchestrator process that manages long-running agentic sessions. The name is fitting: Dispatch spawns and coordinates child tasks, maintains its own session state, and keeps a full audit trail separate from your regular Claude Code sessions.

Each Cowork session runs inside a sandboxed VM with its own process name — codenames like `hopeful-awesome-feynman` or `zealous-wonderful-meitner` — and its own isolated filesystem rooted at `/sessions/{processName}/`. Your real folders are mounted into this sandbox via `userSelectedFolders`, but the session itself doesn't know it's running on your Mac. It thinks it has a fresh environment.

The transcript format is almost identical to Claude Code's JSONL — but the outer wrapper records carry a `session_id` field instead of using filenames as identifiers, and tool names use MCP-style prefixes (`mcp__workspace__bash` instead of `Bash`, `mcp__cowork__request_cowork_directory` for workspace access). These subtle differences are what the new `claude-cowork` provider handles.

---

## Where the Sessions Live

Here's what the filesystem looks like after a few days of Claude Desktop usage:

```
~/Library/Application Support/Claude/
├── claude-code-sessions/          ← Code tab sessions (Desktop provider)
│   └── {accountId}/{orgId}/
│       └── local_{id}.json        ← metadata: title, model, cliSessionId, cwd
│
└── local-agent-mode-sessions/     ← Cowork/Dispatch sessions
    └── {accountId}/{orgId}/
        ├── local_{id}.json        ← metadata: title, model, initialMessage
        └── local_{id}/
            └── audit.jsonl        ← full transcript (self-contained)
```

Compare this to Claude Code's native location:

```
~/.claude/projects/
└── {encoded-cwd}/
    └── {sessionId}.jsonl          ← transcript (CLI sessions)
```

The key distinction: **Cowork transcripts are self-contained**. The audit.jsonl file lives next to its metadata JSON, no cross-referencing required. Desktop Code-tab sessions, by contrast, store only metadata locally — the actual transcript is in `~/.claude/projects/`, referenced by `cliSessionId`.

---

## Three Providers, One Discovery Pass

vibe-replay now runs three parallel discovery passes, each targeting a different location:

### `claude-code` — The original

Scans `~/.claude/projects/` for JSONL files. Streams each file line-by-line, extracting session metadata from the first ~30 lines (slug, model, git branch) and counting prompts and tool calls with lightweight regex passes over every line. Returns one `SessionInfo` per file.

### `claude-desktop` — Code tab sessions from Desktop

Reads metadata from `~/Library/Application Support/Claude/claude-code-sessions/{accountId}/{orgId}/local_*.json`. Each metadata file contains a `cliSessionId` — the UUID of the backing JSONL in `~/.claude/projects/`. The provider encodes the `cwd` field using the same `/` → `-` scheme Claude Code uses for its project directory names, then resolves the JSONL path:

```typescript
const encodedCwd = desktop.cwd.replace(/\/+$/, "").replace(/\//g, "-");
const jsonlPath = join(claudeProjectsDir, encodedCwd, `${desktop.cliSessionId}.jsonl`);
```

Once the JSONL is found, it hands off to the same `extractSessionInfo` function used by the `claude-code` provider, then overlays the richer Desktop metadata (title, model, timestamps) on top.

### `claude-cowork` — Dispatch/autonomous sessions

Reads metadata from `~/Library/Application Support/Claude/local-agent-mode-sessions/{accountId}/{orgId}/local_*.json`. Instead of resolving an external JSONL, it looks for the co-located audit file:

```typescript
const dir = jsonPath.replace(/\.json$/, "");  // local_{id}.json → local_{id}/
const auditPath = join(dir, "audit.jsonl");
```

Then streams the audit.jsonl to count prompts and tool calls — the same line-by-line streaming approach as `claude-code`, but adapted for the Cowork wrapper format.

One ID subtlety that matters: the `sessionId` used for deduplication is derived from the metadata's `sessionId` field (stripping the `local_` prefix), **not** the `cliSessionId`. The `cliSessionId` in a Cowork session identifies the inner Claude Code subprocess running inside the sandbox — a completely different UUID that doesn't appear on the outer audit records the parser reads. Using it for session identity would permanently break replay-to-source linking.

---

## Deduplication: When the Same Session Appears Twice

Claude Code sessions surfaced through the Desktop UI have a real collision problem: the same JSONL file on disk shows up under both `claude-code` (which finds it by scanning `~/.claude/projects/`) and `claude-desktop` (which resolves it via `cliSessionId`). Both providers assign the same `sessionId` to this session.

After all three providers finish discovery, vibe-replay deduplicates by `sessionId` with a priority ordering:

```typescript
const PROVIDER_PRIORITY = ["claude-cowork", "claude-desktop", "claude-code", "cursor"];
```

```typescript
export function deduplicateSessionsByProvider(sessions: SessionInfo[]): SessionInfo[] {
  const seen = new Map<string, SessionInfo>();
  for (const session of sessions) {
    const existing = seen.get(session.sessionId);
    if (!existing) {
      seen.set(session.sessionId, session);
    } else {
      const existingPrio = PROVIDER_PRIORITY.indexOf(existing.provider);
      const newPrio = PROVIDER_PRIORITY.indexOf(session.provider);
      if (newPrio !== -1 && (existingPrio === -1 || newPrio < existingPrio)) {
        seen.set(session.sessionId, session);
      }
    }
  }
  return Array.from(seen.values());
}
```

The priority order reflects data quality: `claude-desktop` keeps the session over `claude-code` because it has richer metadata — the title that Claude Desktop infers, the exact model used, and precise timestamps from the Desktop process. `claude-cowork` ranks first because its transcript is authoritative and self-contained. `cursor` uses an entirely different ID scheme, so it never collides with the Claude family.

---

## What a Cowork Replay Looks Like

Here's a real Cowork session — 125 prompts, 364 tool calls, 6 hours and 40 minutes of autonomous Claude planning a Japan spring break trip:

[![Cowork session landing page showing 'A Claude Cowork session replay by vibe-replay' — 125 turns, $71.07 cost](/blog/dispatch-deep-dive/cowork-landing.png)](/blog/dispatch-deep-dive/cowork-landing.png)

The landing page shows the "Claude Cowork session" label, the sandbox VM's process name as the title, and the tool call summary. Tools include `gmail_read_message`, `AskUserQuestion`, `navigate`, and `Claude_in_Chrome` — the full MCP toolkit that Cowork makes available.

[![The replay player showing the Japan trip planning session — prompt outline on left, conversation in center, tool use tags visible](/blog/dispatch-deep-dive/cowork-player.png)](/blog/dispatch-deep-dive/cowork-player.png)

The player works identically to Claude Code replays. Left panel shows the session outline with every user prompt. Center shows the conversation: `YOU` turns with the user's message, `ASSISTANT` turns with tool-use summaries and the final response.

---

## Desktop Sessions: Richer Metadata

Code-tab sessions running through Claude Desktop get the `claude-desktop` badge and pick up extra metadata that the raw JSONL doesn't contain — the human-readable title Desktop assigns, the exact permission mode, and git worktree context:

[![Claude Desktop session landing showing 'A Claude Desktop session replay' with worktree branch and dangerous mode badge](/blog/dispatch-deep-dive/desktop-session-landing.png)](/blog/dispatch-deep-dive/desktop-session-landing.png)

This session is literally the implementation of the Cowork provider itself. The first prompt: *"Add support for Cowork (Dispatch) sessions to vibe-replay. This builds on top of PR #187..."* The `dangerous mode` badge comes from the Desktop metadata's `permissionMode` field; the `claude/crazy-ishizaka-06a286` tag is the git worktree branch name. Neither is available from the JSONL alone.

---

## The Dashboard: All Sessions in One Place

With three providers running in parallel, the vibe-replay dashboard shows everything:

[![vibe-replay dashboard: 279 sessions — Claude Code 224, Claude Cowork 47, Cursor 6, Claude Desktop 2, plus activity heatmap](/blog/dispatch-deep-dive/dashboard.png)](/blog/dispatch-deep-dive/dashboard.png)

279 sessions total. 224 Claude Code, 47 Cowork, 6 Cursor, 2 Desktop. The heatmap shows activity concentrated in the last few months — that's when most of the Cowork experimentation happened.

The "CLAUDE" badge in the sessions list is `claude-code`. "COWORK" is `claude-cowork`. "DESKTOP" is `claude-desktop`. The badges are how you tell them apart at a glance.

[![Sessions list showing CLAUDE, COWORK, and DESKTOP provider badges](/blog/dispatch-deep-dive/sessions-list.png)](/blog/dispatch-deep-dive/sessions-list.png)

---

## Generating a Replay

If you have Claude Desktop installed with Cowork sessions, generating a replay is one command:

```bash
npx vibe-replay
```

vibe-replay auto-discovers all session types. In the interactive picker, Cowork sessions appear grouped under "Cowork" instead of a filesystem path (since they all run in sandboxed VMs with meaningless paths like `/sessions/hopeful-awesome-feynman`). Select one and a self-contained HTML file drops into `~/.vibe-replay/{sessionId}/index.html`.

You can also target a specific audit.jsonl directly:

```bash
npx vibe-replay \
  -s ~/Library/Application\ Support/Claude/local-agent-mode-sessions/{accountId}/{orgId}/local_{id}/audit.jsonl \
  -p claude-cowork
```

Or let the dashboard surface everything at once:

```bash
npx vibe-replay --dashboard
```

---

## What's Next

A few things on the roadmap for Cowork/Dispatch support:

**Child task visualization** — When Dispatch spawns sub-agents to execute specific tasks in parallel, each gets its own session. Linking these child sessions back to the parent Dispatch conversation (showing the tree structure of orchestrated work) is the next piece.

**MCP tool mapping** — Cowork sessions use MCP tool names (`mcp__workspace__bash`) where Code sessions use short names (`Bash`). The parser normalizes these today, but surfacing the richer MCP context (which server, which operation) in the replay UI would add clarity.

**Cross-session timeline** — If a single Cowork session spawns work across 6 hours and a dozen tool calls, a unified timeline view across all child tasks would tell the full story of what Dispatch actually did.

The foundation is in place. Every audit.jsonl Claude produces is now fair game.

---

*vibe-replay is open source. The providers discussed here landed in [PR #187](https://github.com/tuo-lei/vibe-replay/pull/187). If you run Claude Desktop or Cowork, give it a try.*
