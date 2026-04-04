---
title: "Claude Code /simplify — Watch It Delete 193 Lines From a Real Codebase"
excerpt: "The /simplify slash command reviews your code for duplication, quality issues, and inefficiency — then fixes them. Here's how it works, what it catches, and a full interactive replay of a real session."
date: 2026-04-03
readTime: "5 min read"
---

## What is /simplify?

`/simplify` is a [Claude Code custom slash command](https://docs.anthropic.com/en/docs/claude-code/slash-commands) that reviews your recently changed code for reuse opportunities, quality issues, and efficiency problems — then fixes them directly.

It's not a linter. It doesn't flag style nits. It looks for structural problems: duplicated functions across files, redundant state in React components, O(n^2) loops that should be a Map, polling without change detection, copy-pasted logic that should be a shared hook.

You type `/simplify`, walk away, come back to a cleaner codebase with all tests passing.

We ran it on [vibe-replay](https://github.com/tuo-lei/vibe-replay) itself — a 150-file TypeScript monorepo — and captured the entire session as an interactive replay:

**[Watch the full session replay (67 min, 108 tool calls)](https://vibe-replay.com/view/?gist=e5b2731d90cfa20fee4f3f7ab980cbb1)**

---

## How /simplify works

The command runs a three-phase protocol: identify what changed, review in parallel, then fix.

### Phase 1: Identify changes

`/simplify` starts by running `git diff` to find recently changed files. If there are no uncommitted changes, it reviews the most recent commits. This gives the review agents a focused scope — what code was touched recently and might have introduced duplication or shortcuts.

### Phase 2: Three parallel review agents

This is where it gets interesting. `/simplify` spawns **three independent sub-agents simultaneously**, each analyzing the same code from a different angle:

**Agent 1 — Code Reuse**
Searches for existing utilities and helpers that could replace newly written code. Flags new functions that duplicate existing functionality. Looks for inline logic that could use an existing utility — hand-rolled string manipulation, custom path handling, ad-hoc type guards.

**Agent 2 — Code Quality**
Reviews for redundant state, parameter sprawl, copy-paste with slight variation, leaky abstractions, stringly-typed code where constants exist, unnecessary JSX nesting, and comments that explain "what" instead of "why."

**Agent 3 — Efficiency**
Hunts for unnecessary work (redundant computations, duplicate API calls, N+1 patterns), missed concurrency (sequential awaits that could be parallel), hot-path bloat, recurring no-op updates in polling loops, and overly broad operations.

Each agent reads the full diff, explores the surrounding codebase for context, and reports back independently. The main agent then aggregates findings and filters false positives before making any changes.

### Phase 3: Fix and verify

The agent works through validated findings one by one. After each batch of changes, it runs the full verification cycle — lint, build, test suite — to ensure nothing broke. If a test fails, it diagnoses and fixes before moving on.

---

## What it found in our codebase

We ran `/simplify` on vibe-replay, a monorepo with four packages (CLI, React viewer, shared types, Cloudflare worker). Here's what the agents caught:

### Duplicated utility functions

`shortenPath()` — a 4-line function that replaces `$HOME` with `~` — was copy-pasted into **four separate files** across two provider directories and the scanner. `/simplify` extracted it to a shared `utils.ts` and updated all imports.

`normalizeTitle()` — identical whitespace-collapsing logic in both `index.ts` and `server.ts`, with the constant `TITLE_MAX_CHARS = 120` duplicated too.

### Copy-pasted React patterns

The outside-click handler pattern — `useEffect` + `addEventListener("mousedown")` + `contains()` check — appeared **four times** across `App.tsx` and `Dashboard.tsx`. Extracted to a `useOutsideClick` hook.

Identical filter state + URL sync logic (3 `useState` calls, a `popstate` listener, 3 handler functions) was duplicated between `SessionsPanel` and `ReplaysPanel`. Extracted to a `usePanelFilters` hook.

An 18-line optimistic archive toggle with rollback-on-failure was copied verbatim between two panels. Extracted to `toggleArchiveSlug` in shared utils.

### Hardcoded validation patterns

The Cloudflare worker had the regex `/^[a-zA-Z0-9_-]{10,16}$/` copy-pasted **six times** for cloud replay ID validation, and `/^[a-f0-9]{20,40}$/` three times for gist IDs. The `isDev` environment check (`env.BETTER_AUTH_URL?.startsWith("http://localhost")`) appeared in three separate route handlers.

All extracted to module-level constants and a shared helper function.

### Inefficiency

A React component was polling a cache endpoint every 2.5 seconds and calling `setSources()` unconditionally — triggering re-renders even when the data hadn't changed. `/simplify` added a `cachedAt` timestamp check to skip no-op updates.

A model breakdown component used two sequential `.reduce()` calls with nested `.find()` lookups (O(n^2)) to aggregate model usage data. Replaced with a single-pass `Map`.

### What it skipped (false positives)

Not everything flagged was worth fixing. The agents found that validation constants in `feedback.ts` looked duplicated — the same enum values appeared in a JSON schema string and in runtime `Set` checks. But the schema string is an LLM prompt template, not code logic. Different purpose, not real duplication. `/simplify` recognized this and moved on.

---

## Results

| | |
|---|---|
| User prompts | 3 |
| AI tool calls | 108 |
| Sub-agents spawned | 7 (parallel) |
| Files changed | 16 |
| Lines added | 198 |
| Lines removed | 217 |
| **Net** | **-193 lines** |
| Unit tests | 694 passed |
| E2E tests | 23 passed |
| Tests broken | 0 |
| API-equivalent cost | $4.36 |

---

## How to set it up

`/simplify` is a [custom slash command](https://docs.anthropic.com/en/docs/claude-code/slash-commands). You can add it to any project by creating a markdown file in your `.claude/commands/` directory:

```bash
mkdir -p .claude/commands
```

Then create `.claude/commands/simplify.md` with your review instructions. The command file is a prompt template — it tells Claude Code what to look for and how to structure the review. You can customize the review criteria for your codebase.

Once the file exists, type `/simplify` in any Claude Code session and it runs the full review protocol.

---

## Watch the full session

The best way to understand `/simplify` is to watch it work. This replay captures the entire 67-minute session — every file read, every agent spawned, every fix applied, every test run:

**[Watch the interactive replay](https://vibe-replay.com/view/?gist=e5b2731d90cfa20fee4f3f7ab980cbb1)**

The replay was generated with [vibe-replay](https://github.com/tuo-lei/vibe-replay) — one command (`npx vibe-replay`) that turns any Claude Code session into an interactive animation. The tool replaying its own refactoring.

**[GitHub](https://github.com/tuo-lei/vibe-replay)** | **[Explore Public Replays](/explore)**
