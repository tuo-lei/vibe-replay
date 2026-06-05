# vibe-replay

[![npm version](https://img.shields.io/npm/v/vibe-replay)](https://www.npmjs.com/package/vibe-replay)
[![license](https://img.shields.io/npm/l/vibe-replay)](https://github.com/tuo-lei/vibe-replay/blob/main/LICENSE)

Turn AI coding sessions from Claude Code, Cursor, Codex, and Pi into animated, interactive web replays.

One command. One HTML file. Share anywhere.

## Quick Start

```bash
npx vibe-replay
```

Pick a session from the interactive list, and get a self-contained HTML file with full playback.

Or specify a session directly:

```bash
npx vibe-replay --session ~/.claude/projects/<project>/<session>.jsonl
```

## Features

- Animated replay with play/pause/seek and speed control (1x / 5x / 10x)
- Color-coded timeline (user / thinking / response / tool calls)
- Syntax-highlighted code diffs for Edit/Write operations
- Terminal blocks for Bash commands
- Collapsible thinking blocks
- Markdown-rendered text responses
- VS Code-style outline navigation sidebar
- Session statistics panel
- Light/dark theme toggle
- View preferences (hide thinking, collapse tools, prompts only)
- Keyboard shortcuts (Space, arrows, n/p for turn navigation)
- Screenshot/image display from tool results
- Secret redaction (API keys, tokens, credentials)

## Output

Output: `./vibe-replay/<session-slug>/index.html` (~0.5-4MB)

The HTML file is fully self-contained with zero external dependencies. Open it locally, host on any static server, or push to a CDN.

After generation, choose to:
- **Open in browser** — instant local preview
- **Publish to GitHub Gist** — shareable URL (requires `gh` CLI)
- **Done** — keep the file, deploy manually

## URL-based Loading

The viewer supports loading replay data from a URL:

```
https://your-host/viewer.html?url=https://example.com/replay.json
```

## Supported Providers

| Provider | Status |
|----------|--------|
| Claude Code | Supported |
| Cursor | Supported |
| Codex | Supported |
| Pi | Supported |
| Gemini CLI | Planned |

## Options

```
Usage: vibe-replay [options]

Options:
  -s, --session <path>    Path to a specific JSONL session file
  -p, --provider <name>   Provider name (default: claude-code; supports pi)
  --dev                   Write demo.json for HMR development
  -V, --version           Output the version number
  -h, --help              Display help
```

## Search Local Sessions

For agent-friendly lookup and retros:

```bash
vibe-replay sessions --query "codex parser" --limit 10 --json
vibe-replay sessions --project "vibe-replay" --scan --json
vibe-replay sessions --query "PR review CI" --any --brief --dedupe --json
```

Use `--scan` to include efficiency metrics such as prompt count, tool calls, edits, duration, compactions, and API errors.
Use `--any` for explicit broad recall when you only remember loose keywords. Add `--brief` for scan-backed evidence (`matchQuality`, matched/unmatched terms, match reasons, brief, signals, and next action). Add `--dedupe` to collapse near-duplicate long-prompt sessions.

## Run from Source

```bash
git clone https://github.com/tuo-lei/vibe-replay.git
cd vibe-replay
pnpm install
pnpm build
pnpm start
```

## Requirements

- Node.js >= 20

## License

[MIT](https://github.com/tuo-lei/vibe-replay/blob/main/LICENSE)
