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
Website scripts use Astro 6 and require Node.js >= 22.12.0 inside `website/`. When `nvm` is available, they will try `nvm use` from `website/.nvmrc` automatically.

## Development

```bash
pnpm dev              # Viewer (Vite HMR) + CLI (tsx watch, auto-restart)
pnpm dev:dashboard    # Same as above, opens dashboard directly
pnpm dev:website      # Website (Astro HMR) + Viewer (Vite HMR)
pnpm test             # Run tests
pnpm start            # Full build + run (simulates real user flow)
```

**Daily workflow**: Run `pnpm dev`, open `http://localhost:5173`. Viewer changes hot-reload instantly via Vite HMR. CLI/API changes auto-restart via `tsx watch`. No manual rebuild or restart needed.

## Architecture

pnpm monorepo with three packages:

- **`packages/cli`** — CLI tool published as `vibe-replay` on npm. Discovers sessions, parses them, transforms into scenes, and generates output.
- **`packages/viewer`** — React app built into a single HTML file (~430KB) via `vite-plugin-singlefile`. Handles playback, annotations, theming, and search.
- **`packages/types`** — Shared TypeScript types (`@vibe-replay/types`). Both CLI and viewer re-export from here.

### Data flow

```
Session files (JSONL / SQLite)
  → providers/discover.ts    find sessions on disk
  → providers/parser.ts      parse into ParsedTurn[]
  → transform.ts             convert to Scene[], redact secrets/paths
  → generator.ts             inject JSON into viewer HTML
  → output                   vibe-replay/<slug>/index.html + replay.json
```

### Dashboard terminology and caches

The dashboard uses product terminology that distinguishes original AI sessions from generated replays:

- **Sessions** in the UI are **Source Sessions**: raw/discovered AI coding sessions from providers such as Claude, Cursor, Codex, and Pi. They may or may not have a generated replay yet.
- **Raw transcript/provider data** is provider-owned local storage, such as Claude JSONL, Codex JSONL, Pi JSONL under `~/.pi/agent/sessions`, or Cursor SQLite/globalStorage data.
- **Replays** are generated Vibe Replay artifacts under `vibe-replay/<slug>/`, including `index.html` and `replay.json`.
- **Replay Summaries** are lightweight listings of generated replay artifacts.
- **Source Session Catalog Cache** is the dashboard's materialized cache of source-session summaries plus derived UI/linkage fields such as replay links. It is not raw transcript data.
- **Enrichment** is optional background work, such as detailed Cursor parsing, that improves cached source-session summaries. Enrichment must not imply that provider discovery ran.

Some localhost API names are legacy and must remain backward-compatible:

| Clear term | Preferred route | Legacy route | Meaning |
|------------|-----------------|--------------|---------|
| Source Sessions | `/api/source-sessions*` | `/api/sources*` | Discovered provider sessions / UI Sessions |
| Replays | `/api/replays*` | `/api/sessions*` | Generated replay summaries/artifacts |

Do not change the existing semantics of the legacy routes. New response fields should be additive so older viewers, scripts, and skills can keep reading fields such as `sessions` and `cachedAt`.

The source-session catalog has explicit discovery freshness metadata:

- `discoveredAt` means the last successful provider discovery time.
- Cache envelope `updatedAt` and API `cachedAt` mean the cache file was written. They may be updated by enrichment or replay-linkage sync and must not be used as a proxy for discovery freshness.
- `providerStates` can store provider-specific discovery state and fingerprints. For Pi, `/api/source-sessions/cached` and `/api/sources/cached` cheaply stat JSONL files under `~/.pi/agent/sessions` and return `stale: true` with `staleProviders: ["pi"]` when provider files changed after discovery.

Dashboard code should render cached source sessions immediately, then refresh discovery when `stale` is true or `discoveredAt` is outside the freshness window. When talking to an older server that lacks these fields, fall back to the legacy `cachedAt` TTL behavior.

### CLI structure

```
packages/cli/src/
├── index.ts              # Entry point, interactive picker, publish menu
├── types.ts              # CLI-specific types + re-exports from @vibe-replay/types
├── transform.ts          # Turns → Scenes, secret redaction, cost estimation
├── generator.ts          # Inject JSON into viewer HTML
├── server.ts             # Editor mode: Hono localhost server
├── feedback.ts           # AI Coach integration
├── scan.ts               # Secret detection in output
├── clean-prompt.ts       # Strip system boilerplate from prompts
├── version.ts            # CLI_VERSION from package.json
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
├── types.ts              # Viewer-specific types + re-exports from @vibe-replay/types
├── engine/               # Framework-agnostic playback engine (pure functions)
│   ├── index.ts          # Public exports
│   ├── scene-navigation.ts   # User prompt jumping, next/prev logic
│   ├── scene-timing.ts       # Timing, batching, duration calculation
│   ├── annotation-store.ts   # Pure annotation management
│   └── __tests__/            # Engine unit tests
├── hooks/
│   ├── useSessionLoader.ts   # Load data (embedded / editor API / URL)
│   ├── usePlayback.ts        # Playback state machine (consumes engine/)
│   ├── useAnnotations.ts     # Annotation CRUD + auto-save
│   ├── useTheme.ts           # Light/dark theme via CSS variables
│   └── useViewPrefs.ts       # View preferences (hide thinking, collapse tools)
└── components/
    ├── Player.tsx         # Main playback orchestrator
    ├── Dashboard.tsx      # Session management (editor mode)
    ├── ConversationView.tsx
    ├── Timeline.tsx
    ├── Controls.tsx
    ├── Minimap.tsx
    ├── SearchOverlay.tsx
    ├── AnnotationPanel.tsx
    ├── LandingHero.tsx    # Landing page intro
    ├── StatsPanel.tsx     # Statistics display
    └── [Scene renderers]  # UserPromptBlock, ToolCallBlock, BashBlock,
                           # CodeDiffBlock, TextResponseBlock, ThinkingBlock,
                           # CompactionSummaryBlock
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
- **Shared types** live in `packages/types` (`@vibe-replay/types`) — CLI and viewer re-export from there
- **Secret redaction**: `transform.ts` strips API keys, tokens, PEM keys, paths. `scan.ts` does a second pass on the final output.
- **`</` escaping**: JSON in `<script>` tags must escape `</` as `<\/` (see `generator.ts`)
- **Error handling** — pick one of three, deliberately:
  - **Propagate** when the caller can't proceed without the result (let it throw).
  - **Log** when a step can be skipped but the failure is diagnostically useful — e.g. one provider failing during discovery shouldn't abort the others, but should be visible under `VIBE_REPLAY_DEBUG` (the dashboard stays quiet by default).
  - **Silently swallow** only for genuinely-expected, recoverable cases (an optional file that may be absent, a best-effort cache write). Every such empty `catch` **must carry a one-line comment** explaining why it's safe to ignore — a bare `catch {}` is not allowed.

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
