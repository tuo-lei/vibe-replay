# vibe-replay

[![npm version](https://img.shields.io/npm/v/vibe-replay)](https://www.npmjs.com/package/vibe-replay)
[![license](https://img.shields.io/npm/l/vibe-replay)](./LICENSE)

Turn AI coding sessions into animated, interactive web replays.

One command. One HTML file. Share anywhere.

## Quick Start

```bash
npx vibe-replay
```

That's it. Pick a session, get a self-contained HTML replay file.

Or specify a session directly:

```bash
npx vibe-replay --session ~/.claude/projects/<project>/<session>.jsonl
```

## Command Cheat Sheet

Use this map if you do not want to think about tooling:

```bash
pnpm start       # Final output mode (build + generate local HTML)
pnpm dev         # Daily dev mode (starts viewer + CLI together)
pnpm viewer:dev  # Viewer-only mode (Vite hot reload)
pnpm cli:dev     # CLI-only mode (run CLI source directly)
pnpm test        # Run CLI tests
```

Most people only need:

- `pnpm start` when testing the real user flow
- `pnpm dev` when iterating quickly during development

## What It Does

Reads AI coding session files (supports Claude Code and Cursor), parses the conversation data, and generates a **self-contained single HTML file** (~0.5-4MB) with:

- Animated replay with play/pause/seek controls
- Speed control (1x / 5x / 10x)
- Color-coded timeline (green=user, purple=thinking, blue=response, orange=tool)
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
- Timestamp on each message
- Secret redaction (API keys, tokens, credentials)

Output: `./vibe-replay/<session-slug>/index.html`

After generation, choose to:
- **Dump to demo.json** *(dev mode only)* — fastest dev loop for viewer (`pnpm viewer:dev`)
- **Open in browser** — instant local preview
- **Publish to GitHub Gist** — shareable URL (requires `gh` CLI, supports overwriting a previously published gist for the same replay folder)
- **Done** — keep the file, deploy manually

## URL-based Loading

The viewer supports loading replay data from a URL:

```
https://your-host/viewer.html?url=https://example.com/replay.json
```

Host the viewer once and load different replays via URL parameter.

## Supported Providers

| Provider | Status |
|----------|--------|
| Claude Code | Supported |
| Cursor | Supported (transcripts + `agent-tools` outputs) |
| Codex | Planned |
| Gemini CLI | Planned |

Adding a new provider means implementing `discover()` and `parse()` in a new directory under `packages/cli/src/providers/`.

## Architecture

```
packages/
├── cli/                          # Published as `vibe-replay` on npm
│   └── src/
│       ├── providers/            # Pluggable provider adapters
│       │   ├── claude-code/      # Claude Code JSONL parser
│       │   └── cursor/           # Cursor session parser
│       ├── publishers/           # Output targets (local, gist)
│       ├── transform.ts          # Provider-agnostic scene builder
│       └── generator.ts          # HTML generator
└── viewer/                       # React app → single HTML file
    └── src/
        ├── hooks/                # Playback, theme, preferences
        └── components/           # UI components
```

## Run from Source

```bash
git clone https://github.com/tuo-lei/vibe-replay.git
cd vibe-replay
pnpm install
pnpm build
```

Then run:

```bash
pnpm start                    # Build + interactive picker
pnpm start -- -s <session>    # Build + specific session
pnpm dev                      # Full dev mode: start viewer (Vite) + CLI together
pnpm viewer:dev               # Viewer only (Vite HMR)
pnpm cli:dev                  # CLI only (tsx, no build)
pnpm test                     # Run tests
```

## Development

For daily development (one command):

```bash
# Starts:
# - viewer dev server (http://localhost:5173)
# - CLI interactive picker
pnpm dev
# In CLI menu (dev-only option), choose: "Dump to demo.json"

# Open (or refresh): http://localhost:5173/?file=/demo.json
# Viewer logs: /tmp/vibe-replay-viewer.log
```

Viewer code changes hot-reload instantly. CLI/parser changes require dumping again to refresh `demo.json`.
After CLI exits, `pnpm dev` keeps viewer running so you can preview; press Ctrl+C to stop it.
After you're done, run `pnpm build` from the root to produce the final single-file HTML.

## Tech Stack

- **CLI**: TypeScript, commander, @inquirer/prompts, tsup
- **Viewer**: React 19, Tailwind CSS, Vite, vite-plugin-singlefile, prism-react-renderer, react-markdown
- **Monorepo**: pnpm workspaces

## License

[MIT](./LICENSE)
