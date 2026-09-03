---
title: "What Happens When Claude Code /simplify Runs?"
excerpt: "We captured Claude Code's /simplify workflow as an interactive replay to see file discovery, parallel agents, fixes, and verification—not just the final diff."
cover: "/blog/replay-landing.png"
date: 2026-04-03
updated: 2026-09-03
readTime: "5 min read"
---

## AI code cleanup is a black box — until you watch the replay

`/simplify` is a built-in [Claude Code slash command](https://docs.anthropic.com/en/docs/claude-code/slash-commands) that reviews your recently changed code for duplication, quality issues, and inefficiency — then fixes them directly.

You type `/simplify`, walk away, come back to a cleaner codebase. But what actually happened? Which files did it read? How did it decide what to change and what to skip? Did it break anything along the way?

The useful way to study `/simplify` is to capture the workflow as an interactive replay. That lets you inspect file discovery, agent delegation, fixes, and verification instead of seeing only the final diff. The examples below are synthetic and intentionally omit repository-specific paths and prompts.

---

## What the replay reveals

Without a replay, you usually see only a diff. With vibe-replay, you can inspect the decision-making process — `git diff`, file exploration, sub-agents, and test runs. A typical `/simplify` workflow looks like this:

### Phase 1: Scoping the work

`/simplify` can start with `git diff` to find recently changed files, then explore the surrounding codebase for context. It may read files it never changes because understanding the surrounding code is part of deciding what is safe to simplify.

### Phase 2: Parallel review agents

This is where the replay gets interesting. `/simplify` can spawn independent sub-agents simultaneously, each analyzing the same code from a different angle:

- **Code Reuse agent** — searches for existing utilities that could replace newly written code
- **Code Quality agent** — reviews for redundant state, copy-paste patterns, parameter sprawl
- **Efficiency agent** — hunts for unnecessary work, missed concurrency, hot-path bloat

Each agent can explore a different part of the codebase and report back independently. The main agent then aggregates findings and filters false positives before making changes.

### Phase 3: Fix and verify

After findings are validated, the agent works through them one by one. A good replay shows the verification cycle — lint, build, and tests — plus how a failure is diagnosed before the next change.

---

## What it may find in a codebase

By watching the replay, you can see not just what changed, but *why* each change was made:

### Duplicated utility functions

Repeated path-formatting helpers are a common `/simplify` finding. The reuse agent can discover each copy, compare behavior, and extract a shared utility only when the semantics match.

The same applies to duplicated title normalization and validation constants: the interesting part is not the identifier, but whether the copies have the same contract.

### Copy-pasted React patterns

Repeated outside-click handlers are a useful candidate for a hook when the lifecycle and event behavior are identical.

Repeated filter state and URL synchronization can become a shared hook when the panels have the same URL contract.

### Hardcoded validation patterns

Repeated replay-ID validation is another safe-looking cleanup, but the rule should be defined once and tested at its boundaries before it is shared.

### What it skipped (and why)

This is the most valuable part of watching the replay. An agent may flag the same enum values in a JSON schema and in runtime checks, but those copies can serve different purposes. The schema is an interface for a model; the `Set` is executable validation. The correct outcome may be to leave them separate.

Without the replay, you'd never know this judgment call happened.

---

## Results

| | |
|---|---|
| What to inspect | Why it matters |
| Files read versus changed | Shows whether the agent scoped the task before editing |
| Delegated work | Makes parallel review and aggregation visible |
| Verification commands | Shows whether cleanup was tested rather than assumed |
| Rejected findings | Reveals where the agent avoided an unsafe abstraction |
| Final diff | Confirms the net effect on the codebase |

---

## Try it yourself

1. Run `/simplify` in any [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session — availability can depend on your Claude Code version and configuration.
2. After the session, run `npx vibe-replay` to generate an interactive replay of what happened.
3. Watch the replay to understand every decision the AI made.

The more complex the AI session, the more valuable the replay. `/simplify` is a great example — it spawns parallel agents, makes nuanced judgment calls, and runs verification loops. All of that is invisible without a replay.

**[Read why AI coding sessions need replay](/blog/introducing-vibe-replay/)**

**[GitHub](https://github.com/tuo-lei/vibe-replay)** | **[Explore Public Replays](/explore/)**
