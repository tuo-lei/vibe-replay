@AGENTS.md

<!--
  Shim, not a source of truth. Claude Code reads CLAUDE.md and does not read
  AGENTS.md, so this file imports it. Project knowledge belongs in AGENTS.md so
  that Codex, Cursor, Pi, and opencode see it too.

  Add something here only if it is genuinely Claude-Code-specific — a plan-mode
  rule, a subagent hint, a reference to .claude/ tooling. Anything a different
  agent would also need goes in AGENTS.md.

  packages/cli/test/agent-instructions.test.ts fails if the import above is
  removed or if this file grows past a small size budget.
-->

# Claude Code

- Editing a file triggers the `PostToolUse` hook in `.claude/settings.json`,
  which runs `oxlint --fix` and `oxfmt` on that file. Do not also run `pnpm lint`
  on a file you just edited — it is already formatted.
- Add new skills under `skills/<name>`, then create discovery symlinks under
  `.agents/skills/` and `.claude/skills/` as described in **Agent setup** in
  `AGENTS.md`. Do not create the canonical skill in either discovery directory.
