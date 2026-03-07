# Contributing to vibe-replay

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Setup

```bash
git clone https://github.com/tuo-lei/vibe-replay.git
cd vibe-replay
pnpm install
pnpm build
```

Requires Node.js >= 20 and pnpm.

## Development

```bash
pnpm dev          # Full dev mode: viewer (Vite HMR) + CLI together
pnpm viewer:dev   # Viewer only (http://localhost:5173)
pnpm cli:dev      # CLI only (tsx, no build step)
pnpm test         # Run tests
pnpm start        # Full build + run (simulates real user flow)
```

**Daily workflow**: Run `pnpm dev`, choose "Dump to demo.json" in the CLI menu, then open `http://localhost:5173/?file=/demo.json`. Viewer changes hot-reload instantly. CLI/parser changes require re-dumping.

## Architecture

pnpm monorepo with two main packages:

- **`packages/cli`** — CLI tool published as `vibe-replay` on npm. Discovers sessions, parses them, transforms into scenes, and generates output.
- **`packages/viewer`** — React app built into a single HTML file (~430KB) via `vite-plugin-singlefile`. Handles playback, annotations, theming, and search.

### Data flow

```
Session files (JSONL / SQLite)
  → providers/discover.ts    find sessions on disk
  → providers/parser.ts      parse into ParsedTurn[]
  → transform.ts             convert to Scene[], redact secrets/paths
  → generator.ts             inject JSON into viewer HTML
  → output                   vibe-replay/<slug>/index.html + replay.json
```

### CLI structure

```
packages/cli/src/
├── index.ts              # Entry point, interactive picker, publish menu
├── types.ts              # Core types (Scene, ReplaySession, SessionInfo)
├── transform.ts          # Turns → Scenes, secret redaction, cost estimation
├── generator.ts          # Inject JSON into viewer HTML
├── server.ts             # Editor mode: Hono localhost server
├── feedback.ts           # AI Coach integration
├── scan.ts               # Secret detection in output
├── providers/
│   ├── types.ts          # Provider interface (discover + parse)
│   ├── index.ts          # Provider registry
│   ├── claude-code/      # Claude Code: JSONL parser
│   └── cursor/           # Cursor: SQLite + global state + JSONL
└── publishers/
    ├── local.ts          # Open in browser
    └── gist.ts           # GitHub Gist publishing
```

### Viewer structure

```
packages/viewer/src/
├── App.tsx               # Root component, mode detection
├── hooks/
│   ├── useSessionLoader.ts   # Load data (embedded / editor API / URL)
│   ├── usePlayback.ts        # Playback state machine, timing, keyboard shortcuts
│   ├── useAnnotations.ts     # Annotation CRUD + auto-save
│   └── useTheme.ts           # Light/dark theme via CSS variables
└── components/
    ├── Player.tsx         # Main playback orchestrator
    ├── Dashboard.tsx      # Session management (editor mode)
    ├── ConversationView.tsx
    ├── Timeline.tsx
    ├── Controls.tsx
    ├── Minimap.tsx
    ├── SearchOverlay.tsx
    ├── AnnotationPanel.tsx
    └── [Scene renderers]  # UserPromptBlock, ToolCallBlock, etc.
```

### Viewer modes

The viewer runs in three modes, determined at load time:

| Mode | Data source | Capabilities |
|------|------------|--------------|
| `embedded` | `window.__VIBE_REPLAY_DATA__` (injected by CLI) | Read-only playback |
| `editor` | Fetch from localhost Hono server | Annotations, AI Coach, export, Gist |
| `readonly` | `?gist=<id>` or `?url=<json>` | Read-only, hosted viewer |

### Adding a new provider

1. Create `providers/<name>/discover.ts` — scan disk for sessions, return `SessionInfo[]`
2. Create `providers/<name>/parser.ts` — parse files into `ParsedTurn[]`
3. Create `providers/<name>/index.ts` — implement the `Provider` interface
4. Register in `providers/index.ts`

## Build pipeline

```bash
pnpm build
# 1. Build viewer → packages/viewer/dist/index.html
# 2. Copy to packages/cli/assets/viewer.html
# 3. Build CLI → packages/cli/dist/
```

The viewer is built once, then the CLI embeds it. The final HTML output is the viewer with session JSON injected into a `<script>` tag in `<head>`.

## Key conventions

- **pnpm** only — no npm/yarn
- **TypeScript strict mode**, ESM throughout
- **Viewer must stay under 500KB** after build (currently ~430KB)
- **Output HTML must be fully self-contained** — no external requests
- **`types.ts` is duplicated** between CLI and viewer — sync manually when core types change
- **Secret redaction**: `transform.ts` strips API keys, tokens, PEM keys, paths. `scan.ts` does a second pass on the final output.
- **`</` escaping**: JSON in `<script>` tags must escape `</` as `<\/` (see `generator.ts`)

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes and run `pnpm test`
3. Run `pnpm build` to verify the full build works
4. Test with both small (~30 scenes) and large (~500 scenes) sessions
5. Open a pull request against `main`

Please don't bump versions or publish — releases are handled by maintainers.

## Reporting issues

Open an issue at [github.com/tuo-lei/vibe-replay/issues](https://github.com/tuo-lei/vibe-replay/issues). Include:

- What you expected vs what happened
- Steps to reproduce
- Provider (Claude Code / Cursor) and OS
