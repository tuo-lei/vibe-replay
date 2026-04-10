---
name: replay
description: Generate interactive HTML replays and GitHub PR artifacts (markdown summary + animated GIF) from AI coding sessions. Use when creating PRs with session context, documenting development workflow, sharing coding sessions, or when the user mentions replay/session recording.
allowed-tools: Bash(npx *) Bash(grep *) Bash(ls *) Bash(cat *) Bash(cp *)
argument-hint: [session-path]
---

# Session Replay Generator

Generate replay artifacts from AI coding sessions using [vibe-replay](https://github.com/tuo-lei/vibe-replay).

## Current Session

- Session ID: `${CLAUDE_SESSION_ID}`

## Capabilities

### 1. GitHub PR Artifacts (markdown + animated GIF)

Best for: embedding in PR descriptions, issue comments, documentation.

```bash
npx vibe-replay --session <PATH> --github
```

This generates three files in `~/.vibe-replay/<slug>/`:
- `github-summary.md` — ready-to-paste markdown with stats, tool breakdown, and session details
- `session-preview.gif` — animated GIF showing the session flow (typically 30-60 KB)
- `session-preview.svg` — animated SVG (CSS keyframes, renders natively on GitHub)

The markdown is also printed to stdout.

**To use in a PR**: read `github-summary.md` and include its content in the PR body. If the GIF needs to be visible on GitHub, copy `session-preview.gif` into the repo (e.g., `.github/`) and adjust the image path in the markdown.

### 2. Interactive HTML Replay

Best for: sharing a full interactive replay via file, Slack, or email.

```bash
npx vibe-replay --session <PATH> --open
```

Generates a self-contained HTML file (`~/.vibe-replay/<slug>/index.html`) and opens it in the browser. The HTML makes zero external requests — it can be shared directly.

### 3. Interactive Mode (all features)

For full control (editor, gist publishing, dashboard):

```bash
npx vibe-replay
```

## How to Find the Session File

Find the JSONL file for the current session ID `${CLAUDE_SESSION_ID}`:

```bash
grep -l '"sessionId":"${CLAUDE_SESSION_ID}"' ~/.claude/projects/*/*.jsonl 2>/dev/null
```

If no results, try with a space after the colon:

```bash
grep -l '"sessionId": "${CLAUDE_SESSION_ID}"' ~/.claude/projects/*/*.jsonl 2>/dev/null
```

If multiple files are found (normal with `/resume`), use the first (oldest) path — vibe-replay auto-discovers related files.

## PR Workflow Integration

When creating a PR and the user wants session replay context:

1. Find the session file (see above)
2. Run `npx vibe-replay --session <PATH> --github` to generate artifacts
3. Read the generated `github-summary.md`
4. Include the markdown content in the PR description (e.g., under a `## Session Replay` section)
5. Optionally copy the GIF into the repo for inline display

The markdown output includes:
- Session stats (duration, model, file count)
- Tool usage breakdown
- Collapsible per-prompt details with assistant responses
- Animated preview image (GIF)

## Optional Flags

- `--title "..."` — override auto-detected title
- `--open` — generate HTML and open in browser
- `--github` — generate GitHub artifacts (markdown + GIF + SVG)
