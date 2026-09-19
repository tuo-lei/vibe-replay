---
name: provider-audit
description: Weekly audit of AI provider session transcript formats for drift — new record/item types (new features) and changed field shapes (breaking changes).
schedule: "0 9 * * 1"
timezone: America/Los_Angeles
runner: local
timeout_minutes: 30
---

# Provider session-format audit

You are running the weekly maintainer audit for **vibe-replay** (the repo containing this file at `crons/provider-audit/PROMPT.md`), on behalf of Lei, the maintainer.

**Goal:** catch *format drift* in AI coding-assistant session transcripts early — new record/item types (new provider features), changed field shapes (breaking changes), new tools — before they silently break parsing or ship as missing coverage.

**Core principle:** this is a *judgment* task, not a counting task. A census script can list types; only you, by reading samples, can tell a new user-facing feature from internal runtime noise from a genuine breaking change. When in doubt, sample more, don't guess.

## Procedure

1. **Enumerate providers.** Each `packages/provider-*` directory is a provider (claude, codex, cursor, opencode, hermes, pi, grok-bot, muse, …). Skim its `src/discover.ts` to learn where its sessions live on this machine and which env vars override the location.
2. **Find recent sessions.** List sessions updated in the last 14 days using the provider's own discovery code (run it with `npx tsx` or node against the workspace — do not reimplement discovery by hand).
3. **Census.** Stream (never fully load) the recent session files and collect:
   - top-level record types (e.g. `item`, `compaction_checkpoint`, `session_header`)
   - item `type` values, message `role`s, `source` provenance values
   - tool names actually invoked
   - the shallow field-name set per record/item type (shape fingerprint)
   
   Names and shapes only — no message content.
4. **Compare with the parser.** Read the provider's `src/parser.ts` (and any type registries) and note which types are parsed, which are deliberately skipped, and which are unknown to it.
5. **Diff against the baseline.** `crons/provider-audit/snapshots/<provider>.json` holds the last census (you create it on the first run). New/changed types or shapes since the baseline are your candidates.
6. **Judge each candidate** by pulling 2–3 samples:
   - *New user-facing provider feature* → report it, with a concrete suggestion for parser handling.
   - *Internal runtime record* (provenance markers like `runtime.*`, injections, checkpoints, heartbeats) → note it in the snapshot as known-benign so future runs stay silent.
   - *Changed shape of a type the parser relies on* → **breaking-change candidate**: report prominently, with the old vs new shape.
   - *One-off experiment, tiny frequency* → ignore; mention at most in passing.
7. **Update the baseline.** Write the new census to the snapshot file (marking benign types), so next week's diff is clean.

## Reporting rules

- **Nothing meaningful found →** end your run with exactly one line: `Provider audit clean — no format drift detected.` Nothing else. Do not elaborate, do not list what you checked.
- **Something found →** one concise message to Lei: provider, what changed, first-seen date, frequency, your judgment (feature / breaking / noise), 1–2 redacted samples (field shapes only), and the parser change you'd make. Mention that the snapshot file was updated and is uncommitted.

## Hard rules

- **Privacy:** never paste raw user prompts, tool arguments, or tool outputs. Samples are shapes and type names only.
- **Coverage honesty:** you can only audit providers with local sessions on this machine. Providers Lei doesn't use are invisible to this audit — never claim otherwise.
- **No code changes to parsers.** You audit and propose; Lei decides. The only file you may write is the snapshot.
- Observations about the process itself go to your own persistent notes, not to Lei.
