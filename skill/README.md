# vibe-replay skill

Generate interactive HTML replays and GitHub PR artifacts from AI coding sessions.

## What it does

The `/replay` skill gives your AI agent the ability to:

1. **Generate GitHub PR artifacts** — markdown summary + animated GIF for PR descriptions
2. **Generate interactive HTML replays** — self-contained, shareable files
3. **Auto-integrate with PR workflow** — agent knows how to embed replay context when creating PRs

The skill is both user-invocable (`/replay`) and model-invoked (agent auto-triggers when creating PRs with session context).

## Install

```bash
/plugin install from github:tuo-lei/vibe-replay
```

Or manually copy a single file:

```bash
mkdir -p ~/.claude/skills/replay
curl -o ~/.claude/skills/replay/SKILL.md \
  https://raw.githubusercontent.com/tuo-lei/vibe-replay/main/skill/skills/replay/SKILL.md
```

## Usage

### Slash command

```
/replay                          # Generate replay of current session
/replay ~/path/to/file.jsonl     # Replay a specific session file
```

### In PR workflow

When creating a PR, mention replay and the agent will automatically:
1. Find the current session's JSONL file
2. Generate GitHub artifacts (markdown + animated GIF)
3. Include the session summary in the PR description

Example: "Create a PR for this change, include a session replay"

## Requirements

- Node.js 18+
- macOS or Linux (Windows not yet supported)

## Features

- **GitHub-ready**: Generates markdown + animated GIF optimized for PR descriptions
- **Self-contained HTML**: Interactive replay with zero external requests
- **Multi-provider**: Works with Claude Code and Cursor sessions
- **Auto-discovery**: Finds current session automatically via session ID

## Learn more

- [vibe-replay on GitHub](https://github.com/tuo-lei/vibe-replay)
- [vibe-replay website](https://vibe-replay.com)
- [npm package](https://www.npmjs.com/package/vibe-replay)
