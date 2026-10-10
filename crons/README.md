# crons

Scheduled agent tasks for this repo. Each task is a **prompt, not a script**: the schedule and the instructions live here as data, and any agent can execute them.

There is no cross-agent standard for scheduled tasks, so this folder follows a small convention composed of existing standards: 5-field cron expressions for schedules and `name`/`description` frontmatter in the style of the [Agent Skills spec](https://agentskills.io/specification).

## Anatomy of a task

```
crons/<task-name>/
  PROMPT.md        # required: frontmatter + the task prompt (English)
  README.md        # optional: background, design notes
  snapshots/       # optional: non-sensitive task-owned state; private audits use external state
  ...              # optional: supporting files the prompt references
```

`PROMPT.md` starts with YAML frontmatter:

```yaml
---
name: provider-audit            # required: kebab-case, must match the directory name
description: >-                 # required: what it does and when it runs
  Weekly audit of AI provider session transcript formats for drift.
schedule: "0 9 * * 1"           # required: 5-field cron (minute hour dom month dow)
timezone: America/Los_Angeles   # optional: IANA timezone, default UTC
---
```

The body after the frontmatter is the prompt itself, written for an agent. Write it in English. It should be self-contained: goal, procedure, how to judge results, reporting rules, and hard constraints (privacy, what not to touch).

## Execution

These prompts run **inside an agent**. To schedule one, wire the `PROMPT.md` into your agent's scheduler (a Muse cron, a Grok bot scheduler, a Hermes/OpenClaw scheduled job, …) — the agent reads the prompt and runs it in its own environment.

The repository currently defines these maintenance handoffs (all times `America/Los_Angeles`):

| Task | Schedule | Durable cross-run state |
| --- | --- | --- |
| `daily-code-quality` | Daily 07:00 | GitHub PR history and the `[automation] daily-code-quality ledger` issue |
| `weekly-deps-update` | Monday 02:00 | GitHub PRs, the `[deps] weekly summary` issue, and a dedicated run ledger issue |
| `weekly-issue-fix` | Monday 08:45 | GitHub issues/PRs and the `[automation] weekly-issue-fix ledger` issue |
| `weekly-readme-docs-sync` | Wednesday 02:00 | GitHub merged/open PR history and a dedicated run ledger issue |
| `provider-audit` | Tuesday 02:00 (proposed, enrolled Mac mini only) | One private local ledger and versioned raw/compatibility observations; never GitHub or tracked snapshots |
| `muse-cloud-parity` | Tuesday & Friday 09:06 | GitHub PR history and the local `crons/muse-cloud-parity/watermark.json` |

`weekly-issue-fix` keeps Monday 08:45 (not a round hour) to match the live Eng Grok Bot routine. It is product-issue hygiene, not `daily-code-quality` or `weekly-deps-update`.

These files do not activate a schedule on their own. Maintenance tasks that create PRs need an isolated repository checkout, `pnpm`, GitHub permissions for PRs/issues/comments, and access to current-head Codex review; otherwise their runs must report the missing capability rather than relax the merge rules. The audit-only `provider-audit` instead requires its enrolled Mac, permitted local sources, private state, and Git read access for the pinned baseline; it does not create PRs or request reviews. `weekly-issue-fix` also uses Sentry when available and must continue without it rather than inventing credentials. The review requirement is retained from the previous routines and may still consume Codex review capacity even when a different bot does the coding.

If a task needs machine-local data (local sessions, credentials, paired devices), state that in the prompt body so nobody tries to run it somewhere it can't work. The provider-audit prompt requires an explicitly enrolled Mac mini and permitted local sources; it never falls back to the scheduler's machine or another host. It combines raw schema discovery with independent provider discovery/parser validation, reports partial coverage honestly, and keeps snapshots/ledger outside Git. Its Tuesday cadence is proposed only; old scheduler states are unchanged. See [`provider-audit/README.md`](provider-audit/README.md) for enrollment, private-state and publication rules.

## Adding a task

1. Create `crons/<task-name>/PROMPT.md` with the frontmatter above and an English prompt.
2. Wire it into your agent's scheduler pointing at the file.
3. Define the task's durable-state and privacy contract. Non-sensitive public baselines may live under the task directory (e.g. `snapshots/`); machine-derived private audit state must stay outside Git as specified by `provider-audit/README.md`. Never commit actual session data or machine identifiers.

## Design notes

- Prompts over scripts: when a task needs judgment (triage, taste, deciding what matters), the agent reading samples beats a deterministic script. Scripts are fine as *helpers* the prompt invokes, never as the task itself.
- Silence is a feature: prompts should define when *not* to report. A scheduled task that cries wolf weekly gets deleted.
- Never put secrets, raw user content, or machine-specific absolute paths in a task prompt.
