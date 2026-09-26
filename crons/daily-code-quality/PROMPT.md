---
name: daily-code-quality
description: Daily conservative code-quality scan; make at most one tiny, behavior-preserving PR, or explicitly skip.
schedule: "0 7 * * *"
timezone: America/Los_Angeles
---

# Daily code quality

Run in an isolated, disposable checkout of this repository with GitHub read/write access and pnpm. Read `AGENTS.md`. Never modify a maintainer's working checkout. This prompt is the portable replacement for the former Codex routine; the scheduler must supply its own credentials and retain run output. The schedule is data, not an active scheduler. Use the local date in `America/Los_Angeles` as the run key. Do not ask the sleeping maintainer to make routine decisions.

## Prior state and idempotency

Fetch `origin/main`. Read recent merged/open PRs (especially label `auto-quality`) and the newest three entries in the dedicated GitHub issue titled `[automation] daily-code-quality ledger` (create it if absent, with label `auto-quality`). That issue is the cross-bot candidate/rejection memory; never depend on a local `.codex`, `.claude`, or ignored `plan/` log. Record one concise comment per run date: base SHA, candidate fingerprints (`path`, pattern, source-line hash or nearby symbol), rejection reason, PR/outcome, and the next useful candidate. Do not include source snippets, credentials, or user data. If today's terminal ledger entry already exists, report duplicate and do nothing. If an `auto-quality` PR is open, work on its review/CI state rather than opening another. Deprioritize files frequently touched by people in the last 14 days; skip the same pattern already handled by this routine in the last 7 days. A candidate whose source fingerprint and rejection reason are unchanged since the previous scan should be skipped without expensive validation.

## Discovery and confidence gate

Use only concrete signals: `rg -n 'as any|as unknown' packages/`, `pnpm --filter vibe-replay exec tsc --noEmit`, `pnpm lint:check` (inspect warnings even if exit code is 0), repeated literals/logic occurring at least three times, and actionable `TODO|FIXME|HACK` comments. A hit is a candidate, not proof of a safe fix. Prefer unsafe casts, strict type errors, mechanical repetition, private dead code with zero repository references, then mechanical lint warnings.

Never touch viewer rendering/interactivity/styles, `packages/cli/src/generator.ts`, `packages/cli/src/transform.ts`, D1/Drizzle/database schema, public APIs without clear reference proof, or a sweep across three or more packages. No new dependency, broad formatting/renaming, or behavior-changing bug fix. A typo-level zero-behavior correction is only eligible if its equivalence is demonstrable. Do not manufacture a PR.

Pick one pattern, at most three files and fewer than 80 changed lines. Before any PR, require all of: `pnpm test`, `pnpm lint:check` with zero warnings/errors, strict CLI TypeScript check above, `pnpm build`, and a one-sentence explanation of semantic equivalence. Run E2E when feasible, but a candidate needing browser/UI validation is ineligible, not merely E2E-optional. If a gate fails, try another eligible candidate; if none qualifies, log the rejections and report `No qualified opportunity today` without creating a branch or PR. Follow the repository's pre-commit and pre-PR checks.

## PR lifecycle

Use a task-specific branch, commit only the selected files, and create at most one PR labeled `auto-quality`. Explain the signal, semantic equivalence, exact diff size, validation, and skipped E2E reason. Never push to `main`, release, or bump versions. If a PR is created, stay in this run for review, CI, permitted fixes, and merge; creating it is not completion.

Request `@codex review` for the current head SHA. An acceptable review is a `chatgpt-codex-connector` formal review on that SHA or its issue comment containing `Codex Review:` and a `Reviewed commit` matching that SHA. Inspect formal reviews, issue comments, inline comments, required checks, and merge state. Poll at most every 60 seconds for at most 15 minutes per head, and process at most three reviewed heads. An old-SHA review, a generic approval, or green CI alone is insufficient. If the branch is behind, update normally and re-run CI and review on the new SHA; never use `--admin`. Only mechanical fixes under 30 new diff lines and within the same confidence gate may be pushed; revalidate and re-review. Design/behavior/test uncertainty means stop or close the PR with an explanation. Any unresolved actionable Codex finding, including P2, or changes-requested review blocks self-merge; only explicitly non-actionable nits may be left. A missing review, unresolved finding, red required check, or exhausted loop means leave the PR open and report the exact blocker. Squash-merge only a current head with valid Codex review, no unresolved actionable findings, and all required checks success/skipped. Do not create a follow-up cron or heartbeat.

Report the candidate count and top rejection reasons, selected pattern, checks, PR number/status, and any blocker. Update the ledger even on a clean skip or blocked run. If a plan item exactly matches a merged PR, follow the repository's plan-status convention; never mark a merely related item done.
