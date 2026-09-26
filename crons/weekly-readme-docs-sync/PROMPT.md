---
name: weekly-readme-docs-sync
description: Weekly complete scan of recent feature PRs for one factual README/docs gap.
schedule: "0 2 * * 3"
timezone: America/Los_Angeles
---

# Weekly README/docs sync

Run in an isolated checkout with GitHub access. Read `AGENTS.md`, fetch `origin/main`, and use the `America/Los_Angeles` date as the run key. The scheduler retains the run log; no maintainer-local `.codex`, `.claude`, or ignored `plan/` logs are required. If an `auto-docs` PR is open, inspect/continue its review and CI state instead of opening another. Do not ask the sleeping maintainer to make routine decisions.

List **every** PR merged in the preceding seven days, following GitHub pagination until the result is older than the window (or exhausted). Do not use a fixed `--limit 30`, one API page, or a search result count as the completeness boundary. Record the window, pages fetched, total merged PRs, and eligible feature PR count. Filter for user-visible `feat:` changes and conspicuous `fix:` changes affecting provider/support visibility; inspect PR bodies and code when titles are ambiguous. Internal refactors, performance work, type fixes, and dependency upgrades are not documentation gaps merely because they merged.

Compare each eligible change to `README.md` and relevant `website/src/content/docs/**/*.{md,mdx}` pages. Search for the actual feature/provider terms, then read context; a keyword hit alone is not proof of coverage. A gap must be factual, user-facing, and supported by the merged PR. Prioritize new provider support, then visible UI capability, CLI flag/command, then docs structure. If there are several gaps, choose one highest-value gap and report the remainder for later. If none, report `No documentation gap` with scan counts and no PR.

Edit only an existing README feature/supported-source section, existing website docs content, or `CHANGELOG.md` if an appropriate entry exists. Add the smallest factual sentence/list item in the surrounding style. Do not rewrite existing paragraphs or alter emoji style. Never edit the landing page, hero/tagline/pricing, blog, images/screenshots/GIFs, SEO metadata, package description, product code, tests, or CI. No unverified marketing claims such as fastest/only/production-ready. If the only useful fix requires a forbidden surface, open a concise human-action issue instead of a PR. Keep the entire PR diff under 100 changed lines. Create at most one PR per run.

Run `pnpm lint:check` and the repository's pre-PR `pnpm verify`; if website docs change, also run `pnpm --filter @vibe-replay/website check`. Fix only docs factual/spelling/link or introduced-format issues within the file and diff limits. If checks cannot be made green within scope, report and do not submit an unvalidated PR. Commit the exact files, push a task branch, create a PR labeled `auto-docs`, and link the merged feature PR that justifies every statement. Note out-of-scope gaps explicitly.

Creating the PR is not completion. Request `@codex review` for the current head SHA. Accept a `chatgpt-codex-connector` formal review on that SHA or its issue comment containing `Codex Review:` and a matching `Reviewed commit`. Inspect formal reviews, issue comments, inline comments, required checks, and merge state every 60 seconds at most, for 15 minutes per head maximum and three reviewed heads maximum. Fix only factual docs, spelling, links, or routine-introduced formatting; after each push or normal branch update, repeat CI and Codex review for the new head. If review asks for forbidden files, marketing language, product code, or uncertain facts, leave the PR open and report the blocker. A missing current-head review, blocking finding, red required check, or exhausted loop also leaves it open. Never use `--admin`, push to `main`, or create a follow-up monitor. Squash-merge only a current head with valid Codex review, no blocking findings, and all required checks success/skipped.

In the final run report, include merged/eligible PR counts (show that pagination covered the full window), gaps found, selected gap and source PR, PR status or no-PR reason, deferred gaps, and forbidden-surface issues. Do not claim complete coverage if GitHub pagination or API access failed.
