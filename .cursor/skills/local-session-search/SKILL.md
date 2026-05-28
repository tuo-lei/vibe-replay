---
name: local-session-search
description: Search and analyze local AI coding sessions with vibe-replay. Use when the user asks to find past sessions, inspect agent history, remember prior work, run a retro, analyze prompt quality or agent efficiency, compare sessions, locate a transcript, or choose a session for replay.
---

# Local Session Search

Use `vibe-replay sessions` as the first tool for finding or analyzing past local AI coding sessions. It gives the agent a structured local-session index instead of making the user or agent manually browse Cursor/Claude history.

Prefer `--json` so results can be ranked and summarized without scraping terminal text.

## When To Use

Use this skill when the user asks to:

- Find a previous session, transcript, replay, branch discussion, bug investigation, PR, or design thread.
- Remember what happened in a past agent conversation.
- Retro a session for prompt quality, agent efficiency, repeated intent, tool usage, errors, compactions, or cost.
- Compare multiple sessions or identify which session should be replayed/shared.
- Locate the raw `filePath` / `filePaths` needed for a deeper replay or transcript read.

Do not use this for live dashboard enrichment behavior. Dashboard enrichment is handled by the local server APIs; this skill is for agent-driven lookup and retros.

## Quick Commands

From this repo during development:

```bash
pnpm --filter vibe-replay dev -- sessions --query "<terms>" --limit 10 --json
```

After building from source:

```bash
node packages/cli/dist/index.js sessions --query "<terms>" --limit 10 --json
```

With an installed CLI:

```bash
npx vibe-replay sessions --query "<terms>" --limit 10 --json
```

Useful filters:

```bash
vibe-replay sessions --project "vibe-replay" --json
vibe-replay sessions --provider cursor --query "auth bug" --json
vibe-replay sessions --query "codex parser" --scan --json
```

## Workflow

1. Start shallow: use `--query` or `--project`, `--limit 10`, and `--json`.
2. Rank matches by timestamp, project, title/first prompt match quality, provider, and user intent.
3. Only add `--scan` for the narrowed candidate set when the user asks about retro, efficiency, prompt quality, cost, tool usage, compactions, API errors, files modified, or session quality.
4. Summarize the best matching sessions with provider, timestamp, project, title, first prompt preview, file path, and why each matched.
5. For deep review of one session, use the returned `filePath` or `filePaths` with the replay skill or `vibe-replay --provider <provider> --session <path> --github`.

Avoid broad `--scan` over many sessions. It is intentionally available, but expensive compared with metadata search.

## Retro Guidance

For efficiency analysis, look at:

- Prompt count and whether the user had to repeat intent.
- Tool calls per prompt and edit count per prompt.
- Long duration, API errors, compactions, and subagent count.
- First prompt clarity: goal, constraints, files, expected verification, and merge/review instructions.

When giving retro feedback, separate observations from recommendations. Prefer actionable advice such as "the first prompt had a clear goal but missed verification criteria" or "the session became expensive because it searched broadly before narrowing to one file."

## Output Guidance

For search results, return a short ranked list. Include:

- Title or prompt preview.
- Provider, project, timestamp, and slug/session id.
- Why it matched.
- Whether deeper scan/replay is recommended.

For retros, include the key metrics from `--scan` and a concise prompt/process diagnosis.

## Privacy And Limits

- Do not dump full raw prompts unless the user asks.
- Session data may contain private code, credentials, internal links, or frustrated wording; quote only the minimum needed.
- Treat `vibe-replay sessions` as metadata/subsequence search, not semantic search. If results are weak, broaden terms, filter by project/provider, or inspect a small number of returned transcripts.
- The CLI is independent of dashboard enrichment APIs; do not require the local dashboard server for this workflow.
