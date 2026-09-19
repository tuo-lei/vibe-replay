# crons

Scheduled agent tasks for this repo. Each task is a **prompt, not a script**: the schedule and the instructions live here as data, and any agent (or runner) can execute them.

There is no cross-agent standard for scheduled tasks, so this folder follows a small convention composed of existing standards: 5-field cron expressions for schedules, `name`/`description` frontmatter in the style of the [Agent Skills spec](https://agentskills.io/specification), and GitHub Actions as the default repo-side runner.

## Anatomy of a task

```
crons/<task-name>/
  PROMPT.md        # required: frontmatter + the task prompt (English)
  README.md        # optional: background, design notes
  snapshots/       # optional: task-owned state (baselines, watermarks)
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
runner: local                   # required: local | github-actions (see below)
timeout_minutes: 30             # optional: per-run budget, default 30
---
```

The body after the frontmatter is the prompt itself, written for an agent. Write it in English. It should be self-contained: goal, procedure, how to judge results, reporting rules, and hard constraints (privacy, what not to touch).

## Runners

The folder is the portable contract; the runner is chosen per task via `runner:`.

- **`local`** — the only runner today. The task needs machine-local data (local sessions, credentials, paired devices) and is executed by a personal agent scheduler (e.g. a Muse cron, a Hermes/OpenClaw scheduled job) that references the `PROMPT.md` file. Each agent runs the same prompt against its own environment.
- **`github-actions`** — reserved. When the first repo-data-only task appears, add a generic dispatcher workflow: tick on a schedule, select due tasks from frontmatter, run each prompt with the repo's agent action. No dispatcher ships until a task needs it.

## Adding a task

1. Create `crons/<task-name>/PROMPT.md` with the frontmatter above and an English prompt.
2. Pick `runner: local` (needs this machine) or `runner: github-actions` (repo data only).
3. For `local`, wire it into your agent's scheduler pointing at the file. `github-actions` has no dispatcher yet — add one when the first such task lands.
4. If the task keeps a baseline, store it under the task directory (e.g. `snapshots/`) and update it in the same PR as any behavior change.

## Design notes

- Prompts over scripts: when a task needs judgment (triage, taste, deciding what matters), the agent reading samples beats a deterministic script. Scripts are fine as *helpers* the prompt invokes, never as the task itself.
- Silence is a feature: prompts should define when *not* to report. A scheduled task that cries wolf weekly gets deleted.
- Never put secrets, raw user content, or machine-specific absolute paths in a task prompt.
