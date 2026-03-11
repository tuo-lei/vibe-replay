# vibe-replay

[![npm version](https://img.shields.io/npm/v/vibe-replay)](https://www.npmjs.com/package/vibe-replay)
[![npm downloads](https://img.shields.io/npm/dm/vibe-replay)](https://www.npmjs.com/package/vibe-replay)
[![license](https://img.shields.io/npm/l/vibe-replay)](./LICENSE)

Turn Claude Code and Cursor sessions into shareable, interactive replays.

**PR diffs show _what_ changed. vibe-replay shows _why_** — every prompt, every thought, every edit, in one shareable file. One command. Zero config. Works offline.

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="vibe-replay demo — from session picker to interactive replay" width="800" />
</p>

## Quick Start

```bash
npx vibe-replay
```

Pick a session from the interactive list → get a self-contained HTML replay → share it anywhere.

> **[Watch a live demo →](https://vibe-replay.com/view/?gist=c40137e4c224dc883fe2eaa668e2d8ba)**

## Features

- ⚡ **Zero config** — one command, no setup, no account. Works instantly with existing sessions
- 📦 **Single HTML file** — self-contained, works offline, zero external requests. Drop it in Slack, email it, open it anywhere
- 🔀 **Claude Code + Cursor** — both providers supported out of the box, including multi-file and resumed sessions
- 🎬 **Animated playback** — step through prompts, thinking, tool calls, and diffs at 1x/5x/10x speed
- 🎨 **Rich rendering** — syntax-highlighted diffs, terminal output, screenshots, color-coded timeline

<p align="center">
  <a href="https://vibe-replay.com/view/?gist=c40137e4c224dc883fe2eaa668e2d8ba">
    <img src="docs/screenshots/viewer-hero.png" alt="vibe-replay viewer — animated playback with timeline, outline, and inline diffs" width="800" />
  </a>
  <br />
  <a href="https://vibe-replay.com/view/?gist=c40137e4c224dc883fe2eaa668e2d8ba"><strong>Try this replay live →</strong></a>
</p>

- 💬 **Add comments** — leave notes on any scene. Comments are saved into the HTML file and travel with the replay
- 🤖 **Built-in AI helper** — ask AI to review the session and get feedback on your prompting patterns
- 📋 **Local dashboard** — browse, search, and manage all your sessions in the browser (`-d` flag)
- 🔗 **Share via Gist** — publish to GitHub Gist, get a shareable link on [vibe-replay.com](https://vibe-replay.com)
- 📤 **GitHub export** — markdown summary + animated SVG preview for PRs and READMEs

<p align="center">
  <img src="docs/screenshots/session-preview-demo.svg" alt="Animated SVG export — embeddable session preview for PRs and READMEs" width="800" />
</p>

- 📊 **Session summary** — stats, cost tracking, file impact, token usage at a glance
- 🔒 **Basic secret redaction** — common patterns like API keys and tokens are detected and masked before sharing. Simple pattern matching, not a security guarantee

## Supported Providers

| Provider | Status |
|----------|--------|
| Claude Code | Supported |
| Cursor | Supported |
| More coming soon | — |

## How It Works

```
AI session files  →  vibe-replay  →  self-contained HTML
(Claude Code,        (parse,          (animated viewer,
 Cursor)              redact,          offline-ready,
                      transform)       shareable)
```

The CLI discovers sessions on your machine, parses the conversation data, and packages it into a pre-built React viewer — one HTML file that works anywhere.

After generation:
- **Open in Editor** — annotate, get AI feedback, export to multiple formats, publish to Gist
- **Quick preview** — open in browser instantly
- **Publish to Gist** — shareable link on [vibe-replay.com](https://vibe-replay.com)
- **Export for GitHub** — markdown + animated SVG for PRs

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
