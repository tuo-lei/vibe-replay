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
so in your report. Reaffirmed by Lei on 2026-10-05 after Codex asked to
remove the 30-minute exception in PR #702's review: keep the exception.

## Procedure

1. **Sync.** First check GitHub for an open PR from this task (its
   `chore/muse-cloud-parity-*` branch): a previous run may have left one
   open because review or CI was blocked — resuming it is your first job,
   so check out and continue that branch instead of starting a new audit.
   With no open task PR, `git checkout main` (a reused checkout may still
   sit on a deleted PR branch — a bare `git pull` would follow the stale
   upstream), then `git pull` latest `main`. Note the HEAD SHA as the run's
   base, but
   do not write it to `last_verified_commit` yet — that field is only
   updated after every check below passes, and then to the SHA that
   actually passed them: the base SHA for a clean run, or the merged PR's
   merge-commit SHA for a run that shipped fixes (the pre-fix base failed
   checks and must never be recorded as verified).
2. **Build.** After every sync, run `pnpm install --frozen-lockfile` (a
   reused checkout's `node_modules` can be stale even when present — a pull
   that only bumps an installed dep would otherwise test the old tree; the
   frozen flag also keeps the run from silently repairing `pnpm-lock.yaml`
   instead of validating the committed graph), then `pnpm build`.
   The install's EPERM chown of `.modules.yaml` is non-fatal here (exit 0);
   verify with `pnpm build` rather than re-running.
   Environment quirks: if `pnpm` is missing, install the exact pinned
   version — parse it from `package.json`'s `packageManager` field
   (`node -p "require('./package.json').packageManager.replace(/^pnpm@/,'').split('+')[0]"`)
   and install that (e.g. `/opt/hatch-image/bin/npm install -g
   pnpm@<exact-pinned-version>`), never an arbitrary latest. The pnpm-only
   rule governs project commands, not bootstrapping the package manager
   itself. If pnpm fails with EPERM
   on the `packageManager` pin, delete that line from `package.json` for the
   pnpm commands, then `git checkout -- package.json` to restore it — never
   commit the pin removal. Ensure `pnpm` is on PATH (`command -v pnpm`) and
   run `pnpm lint:check` (fix all errors) before committing; then commit
   normally so the lefthook pre-commit hook also runs on the staged files.
   Never use `--no-verify` to bypass it.
3. **Discover.** Run `packages/provider-muse`'s own discovery
   (`src/muse/discover.ts` — do not reimplement it) against this machine's
   Muse sessions (`~/agents/<agent-id>/sessions/<agent-id>.jsonl`) and
   confirm sessions from the last 14 days are found.
4. **Integrity.** Stream (never fully load) every stable session file from
   the 14-day window — not just a recent sample; a malformed or
   parse-failing transcript outside the sample would otherwise go unseen
   while the run reports clean. Skip files with activity in the last ~60s
   (this run itself is a Muse agent whose actively appended JSONL is among
   the recent files, and a partial final record at EOF during an append
   would otherwise be falsely flagged corrupt). Flag corrupt/truncated
   JSONL lines (only after confirming the file's size and mtime are
   stable), sessions that fail to parse, and
   any zero-prompt-but-tool-calls session as a discovery/generation
   mismatch: discovery lists it as replayable, but `hasReplayableContent`
   (`packages/cli/src/server-core.ts`) requires at least one `user-prompt`
   scene, so generation would reject it — that gap is a parity failure
   until the CLI actually supports tool-only replays. Shapes and type names
   only — never raw prompts, tool arguments, or tool outputs.
5. **Drift.** Collect from every stable session file in the 14-day window
   (same coverage rule as step 4 — a new record shape outside a sample
   would otherwise go unseen): top-level record types, item `type` values,
   the shallow field-name set per type, the nested
   `message_parts.parts[].type` values with their nested key/type
   signatures (the parser's `textFromItem` only accepts `{type: "text",
   text}` parts, so a new part type with unchanged outer keys would
   otherwise slip past the census), the tool names actually invoked with
   their privacy-safe decoded argument-key sets (the `arguments` field is
   a JSON string — collect key names only, never values), the
   `record.source` provenance-label set (the parser's
   `isRuntimeInjectionSource` branches on exact labels like
   `scheduler.cron` and the `runtime.*` prefix, so a new
   scheduler/background label with an unchanged record shape would
   otherwise go undetected), and privacy-safe key/type signatures for
   ordinary record and item fields (e.g. `text: string`,
   `output: string|object` — the parser's string checks silently drop
   content when a relied-on field changes type without changing keys).
   Compare with `src/muse/parser.ts` and
   `src/muse/tool-mapping.ts`. A new user-facing Muse feature the parser
   ignores → extend the parser. A new built-in tool name or a changed
   argument shape → mapping-coverage candidate (terminal output/diff
   rendering and edit analytics silently degrade otherwise). A changed
   shape the parser relies on → breaking-change candidate, fix it
   prominently.
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
   `replay.json` with no unescaped `</script>`. When the run changed the
   Muse parser or any replay-affecting code, validate both required replay
   sizes: a ~30-scene and a ~500-scene representative session, not just the
   single most recent one. A green unit suite alone does not
   pass this step — this is the "Lei can actually use Replay on Muse
   sessions" test.
7. **Fix, test, PR.** Create and switch to a task branch
   (`git checkout -b <task-branch>`) before editing or committing — never
   commit fixes on local `main`, or the local checkout diverges from the
   squash-merged remote `main` and breaks the next run's pull. Implement
   the fixes. After every fix, re-run the affected checks from steps 3–6 —
   including the real-session E2E replay generation (both required sizes
   when replay-affecting code changed) — against the fixed code before
   `pnpm verify`: the pre-fix checks ran against the broken code, and a fix
   that was never exercised on the real failing session must not be
   opened or merged. Rebuild the affected artifacts first (`pnpm build`,
   or `pnpm --filter vibe-replay build` for CLI-only changes — the step-2
   build predates the fix, so re-running checks against the stale bundle
   proves nothing). Before commit: ensure `pnpm` is on PATH (`command -v pnpm`),
   run `pnpm lint:check` and fix all errors, then commit normally so the
   lefthook pre-commit hook runs — it applies
   and stages oxlint/oxfmt fixes, which `pnpm lint:check` alone does not.
   If the hook fails for an environment reason despite pnpm being on PATH,
   report blocked rather than committing with `--no-verify`. Also do a
   security review of the diff before commit (no secrets, keys, tokens,
   credentials). Before PR:
   `pnpm verify` with sequential stages.
   Open the PR with `~/workspace/skills/github/bin/gh_push_pr.py`, always
   passing `--branch <branch>` explicitly (its default branch is stale).
   Never bump versions or publish.
8. **Review → merge.** Wait for the Codex auto-review (usually ~10 min; poll
   for up to 30 min). Read every comment and address each one — fix, or push
   back with a reasoned reply — pushing follow-ups to the same branch.
   After every follow-up push, wait for a fresh Codex review of the new head
   before merging: fixes pushed after a review must themselves be reviewed.
   Before merging, also confirm the branch is current with `main` — if
   `main` advanced during the audit/review window, update the branch from
   `main` and re-run the affected parity checks, CI, and a fresh
   current-head review, or the squash merge produces a tree this run never
   exercised. Squash merge only when the latest head has a Codex review
   with no unaddressed comments and CI is green, then delete the remote
   branch.
   (If the review never appears, see Standing authorization.)
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
