# vibe-replay

[![npm version](https://img.shields.io/npm/v/vibe-replay)](https://www.npmjs.com/package/vibe-replay)
[![license](https://img.shields.io/npm/l/vibe-replay)](./LICENSE)

Turn AI coding sessions into animated, interactive web replays.

One command. One HTML file. Share anywhere.

<!-- TODO: add demo GIF here -->

## Quick Start

```bash
npx vibe-replay
```

Pick a session, get a self-contained HTML file. Done.

## Features

- **Animated playback** — play/pause/seek through the full conversation with 1x/5x/10x speed
- **Rich tool rendering** — syntax-highlighted diffs, terminal output, screenshots
- **Color-coded timeline** — see user prompts, thinking, responses, and tool calls at a glance
- **Search & navigate** — Cmd+K search, minimap, outline sidebar, keyboard shortcuts
- **Annotations** — add comments to any scene, get AI-powered prompting feedback
- **Share anywhere** — publish to [vibe-replay.com](https://vibe-replay.com) via GitHub Gist, or just send the HTML file
- **Privacy first** — API keys, tokens, credentials, and paths are automatically redacted
- **Light & dark themes** — with customizable view preferences
- **Faster startup** — file-based stale cache shows sessions immediately while latest sessions refresh in background

## Supported Providers

| Provider | Status |
|----------|--------|
| Claude Code | Supported |
| Cursor | Supported |
| Codex | Planned |
| Gemini CLI | Planned |

## How It Works

```
AI session files → vibe-replay → self-contained HTML
```

The CLI discovers sessions on your machine, parses the conversation data, and injects it into a pre-built React viewer — producing a single HTML file (~430KB + session data) that works offline, no server needed.

After generation you can:
- **Open in Editor** — annotate, get AI feedback, export, publish to Gist
- **Open in browser** — instant preview
- **Publish to Gist** — shareable link on [vibe-replay.com](https://vibe-replay.com)

## Development

```bash
git clone https://github.com/tuo-lei/vibe-replay.git
cd vibe-replay
pnpm install
pnpm dev          # Viewer (Vite HMR) + CLI together
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for architecture details and development workflow.

## License

[MIT](./LICENSE)
