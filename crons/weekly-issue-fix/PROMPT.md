---
name: weekly-issue-fix
description: Weekly Eng hygiene — scan open bugs/PRs/CI/Sentry; ship at most one small product fix PR or stay silent.
schedule: "45 8 * * 1"
timezone: America/Los_Angeles
---

# Weekly product issue/PR hygiene

Run in an isolated, disposable checkout of this repository with GitHub read/write access and pnpm. Read `AGENTS.md`. Never modify a maintainer's working checkout. The scheduler supplies credentials and retains run output; never depend on a local `.codex`, `.claude`, or ignored `plan/` log. The schedule is data, not an active scheduler. Use the local date in `America/Los_Angeles` as the run key. Do not ask the sleeping maintainer to make routine decisions.

This encodes the former Eng Grok Bot routine "Weekly vibe-replay issue fix". It is **not** `daily-code-quality` (tiny behavior-preserving auto-quality PRs) and **not** `weekly-deps-update` (dependency patches). Do not duplicate those routines.

## Prior state and idempotency

Fetch `origin/main`. Find the dedicated GitHub issue titled `[automation] weekly-issue-fix ledger` (create it if absent, with label `auto-eng`). Use `auto-eng` for this routine's ledger and PRs — it is distinct from `auto-quality`, `auto-deps`, and `auto-docs`, which belong to other crons. Create the `auto-eng` label if it does not exist (short description: weekly Eng product-issue hygiene). That ledger issue is the cross-bot run memory. If its comments already contain a terminal entry for today's run key, report duplicate and stop, even if that run's PR has merged or closed. If an `auto-eng` PR is already open, continue that PR's review/CI instead of opening another. Do not include source snippets, credentials, user data, or Sentry payloads in the ledger.

## Scan and judgment

Scan, then pick **at most one** actionable product bug or small fix:

- Open GitHub issues (bugs and small concrete fixes). Exclude pure deps/automation noise: `[deps] weekly summary`, `[automation] *-ledger` issues, and other work owned by `auto-deps` / `auto-quality` / `auto-docs`.
- Open PRs that are small Eng product fixes waiting on merge. Prefer continuing this routine's own `auto-eng` PR. A small unowned Eng-fix PR may be advanced only when remaining work is review/CI/mechanical and the existing diff is already in scope; do not hijack feature, docs, or dependency PRs.
- `main` branch CI status. A failed required check with a clear small fix is a strong candidate.
- Sentry unresolved issues for the vibe-replay / tuo-lei project, if accessible. If Sentry tools or credentials are unavailable, note that once in the ledger and continue; do not invent secrets, DSNs, or machine paths. Report issue titles/IDs and coarse error type only — never request bodies, user content, or stack frames that include paths/PII.

Prefer concrete product bugs, provider regressions, broken docs that block users, and failed `main` CI with a clear small fix. Skip: dependency bumps, broad refactors, feature requests without a clear tiny fix, anything needing product design debate, and security that needs human judgment (leave those for a human; never self-merge). A candidate is not proof of a safe fix. Prefer fewer than ~200 changed lines and a narrow scope. Do not manufacture a PR to fill the schedule. If nothing qualifies, create no branch or PR.

Validate with the repository's normal gates before any PR: `pnpm lint:check` with zero warnings/errors, `pnpm test`, `pnpm typecheck`, and `pnpm build` (or the full sequential `pnpm verify` when that is the cheapest way to run them). Follow `AGENTS.md`: viewer changes need `pnpm build`; CLI-only changes may use `pnpm --filter vibe-replay build`. Run `pnpm test:e2e` when the change touches generated HTML, the editor server, CLI flows, auth, or other viewer/CLI paths that sibling crons would require. If a gate fails, try another eligible candidate; if none qualifies, log the rejections. Do not weaken tests, edit CI, or change unrelated files to make a fix pass.

## PR lifecycle

Use a task-specific branch, commit only the selected files, and create at most one PR labeled `auto-eng`. Explain the signal (issue/PR/CI/Sentry), the fix, exact diff size, validation, and E2E status or why E2E was not required. Never push to `main`, release, or bump versions. If a PR is created, stay in this run for review, CI, permitted fixes, and merge; creating it is not completion.

Request `@codex review` for the current head SHA. An acceptable review is a `chatgpt-codex-connector` formal review on that SHA or its issue comment containing `Codex Review:` and a `Reviewed commit` matching that SHA. Inspect formal reviews, issue comments, inline comments, required checks, and merge state. Poll at most every 60 seconds for at most 15 minutes per head, and process at most three reviewed heads. An old-SHA review, a generic approval, or green CI alone is insufficient. If the branch is behind, update normally and re-run CI and review on the new SHA; never use `--admin`. Only mechanical fixes under 30 new diff lines and within the same scope/gates may be pushed; revalidate and re-review. Design/behavior/test uncertainty, or a security question that needs a human, means stop and leave the PR open with an explanation. Any unresolved actionable Codex finding, including P2, or changes-requested review blocks self-merge; only explicitly non-actionable nits may be left. A missing review, unresolved finding, red required check, or exhausted loop means leave the PR open and report the exact blocker. Squash-merge only a current head with valid Codex review, no unresolved actionable findings, and all required checks success/skipped. Do not create a follow-up cron or heartbeat.

## Report and ledger

Always append one terminal ledger comment, even on a clean skip: run key, base SHA, scan summary (issue/PR/CI/Sentry counts, and whether Sentry was unavailable), candidate or skip reason, and PR outcome or exact blocker. If the run fails before a terminal outcome, do not record it as terminal; a retry may resume. Do not paste secrets, raw user content, or Sentry payloads.

If a PR was merged or left open with a blocker, the scheduler's final report should say so briefly (PR number, status, blocker). If nothing actionable, report quietly with a single line such as `No actionable product fix this week` — no filler, no user-facing noise. Silence is a feature.
