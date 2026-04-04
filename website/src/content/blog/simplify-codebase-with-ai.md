---
title: "What Actually Happens When Claude Code /simplify Cleans Your Codebase"
excerpt: "We ran the built-in /simplify command on our own repo and captured every file read, agent spawn, and fix as an interactive replay. Here's what we learned by watching the black box."
date: 2026-04-03
readTime: "5 min read"
---

## AI code cleanup is a black box — until you watch the replay

`/simplify` is a built-in [Claude Code slash command](https://docs.anthropic.com/en/docs/claude-code/slash-commands) that reviews your recently changed code for duplication, quality issues, and inefficiency — then fixes them directly.

You type `/simplify`, walk away, come back to a cleaner codebase. But what actually happened? Which files did it read? How did it decide what to change and what to skip? Did it break anything along the way?

We ran `/simplify` on [vibe-replay](https://github.com/tuo-lei/vibe-replay) itself — a 150-file TypeScript monorepo — and captured the entire session as an interactive replay so you can see exactly what the AI did:

**[Watch the full session replay (67 min, 108 tool calls)](https://vibe-replay.com/view/?gist=e5b2731d90cfa20fee4f3f7ab980cbb1)**

---

## What we learned by watching the replay

Without the replay, we'd just see a diff. With vibe-replay, we could watch the entire decision-making process unfold — every `git diff`, every file exploration, every sub-agent spawned, every test run. Here's what `/simplify` actually did:

### Phase 1: Scoping the work

The replay shows `/simplify` starting with `git diff` to find recently changed files, then exploring the surrounding codebase for context. You can see it reading files it never changes — understanding the codebase before making decisions.

### Phase 2: Three parallel review agents

This is where the replay gets interesting. You can watch `/simplify` spawn **three independent sub-agents simultaneously**, each analyzing the same code from a different angle:

- **Code Reuse agent** — searches for existing utilities that could replace newly written code
- **Code Quality agent** — reviews for redundant state, copy-paste patterns, parameter sprawl
- **Efficiency agent** — hunts for unnecessary work, missed concurrency, hot-path bloat

In the replay, you can see each agent exploring different parts of the codebase in parallel, then reporting back independently. The main agent aggregates findings and filters false positives before making any changes.

### Phase 3: Fix and verify

The replay shows the agent working through validated findings one by one. After each batch of changes, you can watch it run the full verification cycle — lint, build, test suite — and when a test fails, you can see exactly how it diagnoses and fixes the issue before moving on.

---

## What it found in our codebase

By watching the replay, we could see not just what changed, but *why* each change was made:

### Duplicated utility functions

`shortenPath()` — a 4-line function that replaces `$HOME` with `~` — was copy-pasted into **four separate files** across two provider directories and the scanner. The replay shows the reuse agent discovering each copy, then extracting it to a shared `utils.ts`.

`normalizeTitle()` — identical whitespace-collapsing logic in both `index.ts` and `server.ts`, with the constant `TITLE_MAX_CHARS = 120` duplicated too.

### Copy-pasted React patterns

The outside-click handler pattern — `useEffect` + `addEventListener("mousedown")` + `contains()` check — appeared **four times** across `App.tsx` and `Dashboard.tsx`. Extracted to a `useOutsideClick` hook.

Identical filter state + URL sync logic (3 `useState` calls, a `popstate` listener, 3 handler functions) was duplicated between `SessionsPanel` and `ReplaysPanel`. Extracted to a `usePanelFilters` hook.

### Hardcoded validation patterns

The Cloudflare worker had the regex `/^[a-zA-Z0-9_-]{10,16}$/` copy-pasted **six times** for cloud replay ID validation. All extracted to module-level constants.

### What it skipped (and why)

This was the most valuable part of watching the replay. The agents flagged validation constants in `feedback.ts` as duplicated — the same enum values appeared in a JSON schema string and in runtime `Set` checks. But watching the replay, you can see the agent reason through this: the schema string is an LLM prompt template, not code logic. Different purpose, not real duplication. It recognized this and moved on.

Without the replay, you'd never know this judgment call happened.

---

## Results

| | |
|---|---|
| User prompts | 3 |
| AI tool calls | 108 |
| Sub-agents spawned | 7 (parallel) |
| Files changed | 16 |
| Lines added | 289 |
| Lines removed | 369 |
| **Net** | **-80 lines** |
| Unit tests | 694 passed |
| E2E tests | 23 passed |
| Tests broken | 0 |
| API-equivalent cost | $4.36 |

---

## Try it yourself

1. Run `/simplify` in any [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session — it's built in, no setup required.
2. After the session, run `npx vibe-replay` to generate an interactive replay of what happened.
3. Watch the replay to understand every decision the AI made.

The more complex the AI session, the more valuable the replay. `/simplify` is a great example — it spawns parallel agents, makes nuanced judgment calls, and runs verification loops. All of that is invisible without a replay.

**[Watch the interactive replay](https://vibe-replay.com/view/?gist=e5b2731d90cfa20fee4f3f7ab980cbb1)**

**[GitHub](https://github.com/tuo-lei/vibe-replay)** | **[Explore Public Replays](/explore)**
