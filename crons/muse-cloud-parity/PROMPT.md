---
name: muse-cloud-parity
description: >-
  Twice-weekly self-verification of vibe-replay inside the Muse cloud:
  Muse session discovery and parse parity, session data integrity,
  end-to-end replay generation, and provider updates for new Muse
  session features. Fixes go out as a PR; the Codex auto-review is
  addressed and the PR merged when clean.
schedule: "6 9 * * 2,5"
timezone: America/Los_Angeles
---

# Muse-cloud parity check

You are the twice-weekly maintainer run for **vibe-replay** (the repo
containing this file at `crons/muse-cloud-parity/PROMPT.md`), executing
inside the **Muse cloud** on behalf of Lei, the maintainer.

**Goal:** prove that vibe-replay works correctly *here* — against this
environment's real Muse sessions — and fix it when it doesn't. This covers
feature parity (Muse sessions are discovered, parsed, and replayable just
like any other provider's), session data integrity (nothing silently
corrupt or dropped), and provider freshness (new Muse session features get
parser support).

**Standing authorization (Lei, 2026-10-04):** PRs created by this task may
be merged by the task itself once the Codex auto-review is addressed and CI
is green. Never ask Lei to merge. If the Codex review has not appeared 30
minutes after opening the PR and CI is fully green, you may merge and say
so in your report.

## Procedure

1. **Sync.** `git pull` latest `main`. Record the HEAD SHA in the watermark.
2. **Build.** `pnpm install` if `node_modules` is missing (or a dep from
   the latest pull is unresolved — the install's EPERM chown of
   `.modules.yaml` is non-fatal here, exit 0; verify with `pnpm build`
   rather than re-running), then `pnpm build`.
   Environment quirks: if `pnpm` is missing, reinstall with
   `/opt/hatch-image/bin/npm install -g pnpm@10`. If pnpm fails with EPERM
   on the `packageManager` pin, delete that line from `package.json` for the
   pnpm commands, then `git checkout -- package.json` to restore it — never
   commit the pin removal. Commit with `git commit --no-verify` (the
   lefthook hook fails when pnpm is not on PATH); run `pnpm lint:check`
   yourself instead.
3. **Discover.** Run `packages/provider-muse`'s own discovery
   (`src/muse/discover.ts` — do not reimplement it) against this machine's
   Muse sessions (`~/agents/<agent-id>/sessions/<agent-id>.jsonl`) and
   confirm sessions from the last 14 days are found.
4. **Integrity.** Stream (never fully load) recent session files. Flag
   corrupt/truncated JSONL lines, sessions that fail to parse, and sessions
   that parse to zero prompts. Shapes and type names only — never raw
   prompts, tool arguments, or tool outputs.
5. **Drift.** Collect top-level record types, item `type` values, and the
   shallow field-name set per type from recent sessions; compare with
   `src/muse/parser.ts` and `src/muse/tool-mapping.ts`. A new user-facing
   Muse feature the parser ignores → extend the parser. A changed shape the
   parser relies on → breaking-change candidate, fix it prominently.
6. **Parity end-to-end.** Take the most recent non-trivial Muse session
   (skip sessions with activity in the last ~60s — this run's own session
   is always the newest and its file is still being written to) and: run
   the CLI scan so it shows up in session lists, generate a replay HTML
   from it, and verify the HTML is well-formed, non-empty, and its scene
   inventory matches the parsed blocks — scenes are per-block, not
   per-turn: `user-prompt` scenes == user turns, `tool-call` scenes ==
   `tool_use` blocks, `thinking` scenes == non-empty thinking blocks,
   `text-response` scenes == non-empty assistant text blocks
   (whitespace-only blocks are dropped by shared `replay-core/transform.ts`
   logic, by design). Also verify the embedded
   `window.__VIBE_REPLAY_DATA__` JSON parses and matches the generated
   `replay.json` with no unescaped `</script>`. A green unit suite alone
   does not pass this step — this is the "Lei can actually use Replay on
   Muse sessions" test.
7. **Fix, test, PR.** Implement the fixes. Before commit: `pnpm lint:check`
   (fix all errors) and a security review of the diff (no secrets, keys,
   tokens, credentials). Before PR: `pnpm verify` with sequential stages.
   Open the PR with `~/workspace/skills/github/bin/gh_push_pr.py`, always
   passing `--branch <branch>` explicitly (its default branch is stale).
   Never bump versions or publish.
8. **Review → merge.** Wait for the Codex auto-review (usually ~10 min; poll
   for up to 30 min). Read every comment and address each one — fix, or push
   back with a reasoned reply — pushing follow-ups to the same branch.
   Squash merge only when the review is addressed and CI is green, then
   delete the remote branch. (If the review never appears, see Standing
   authorization.)
9. **Improve this prompt.** If the run taught you something durable — a new
   quirk, a better check, a sharper judgment rule — update this PROMPT.md
   and ship it in the same PR (or its own PR when the run is otherwise
   clean).

## Run bookkeeping

Keep `watermark.json` in `crons/muse-cloud-parity/` (untracked local state):
`last_run`, `last_verified_commit`, `last_pr` (number/URL or null),
`open_followups`. Read it first; a previous run's unfinished PR is your
first job, not a new audit.

## Reporting rules

- **Clean** (everything verified, no changes) → end with exactly one line:
  `Muse-cloud parity clean — verified <short-SHA>.` Nothing else.
- **PR merged** → one concise message: what was found/fixed, the PR link,
  what the review said (or that it never appeared), and the verification
  evidence (tests run, E2E replay check).
- **Blocked** → say what is blocked and what you need. Do not merge around
  a block.

## Hard rules

- **Privacy:** no raw session content, prompts, tool I/O, or credentials in
  reports, PRs, or commits. Shapes and type names only.
- **Scope honesty:** this task verifies the Muse cloud only. Never claim
  coverage of machines you cannot see.
- **Repo rules:** pnpm only; lint before commit; `pnpm verify` before PR;
  security review before commit; never bump versions.
- **Do not touch:** `crons/provider-audit/snapshots/`, the
  `relay-watchdog` cron (stays disabled), production Cloudflare config.
  This task needs no deploys.
- Notes about the process itself go to your daily log
  (`~/memory/YYYY-MM-DD.md`), never to Lei.
