# CLAUDE.md — vibe-replay

## Project Overview

vibe-replay turns AI coding sessions into animated, interactive web replays as self-contained HTML files. Supports Claude Code and Cursor, designed to extend to Codex/Gemini.

pnpm monorepo:
- `packages/cli` — CLI tool published as `vibe-replay` (TypeScript, commander, tsup)
- `packages/viewer` — React web app (Vite, Tailwind, vite-plugin-singlefile)
- `website/` — Astro marketing site (vibe-replay.com)
- `cloudflare/` — Cloudflare Workers API

## Build & Run

```bash
pnpm install
pnpm build                 # Full build (viewer → CLI)
pnpm start                 # Build + run interactive picker
pnpm dev                   # Full dev mode (viewer + CLI together)
# pnpm dev runs viewer in background; logs: /tmp/vibe-replay-viewer.log
# After CLI exits, viewer stays alive for preview until Ctrl+C
pnpm viewer:dev            # Viewer-only dev server (Vite)
pnpm cli:dev               # CLI-only dev mode (tsx)
pnpm test                  # Run tests
npx tsx packages/cli/src/index.ts -s <path> --dev  # Write demo.json for HMR
# Or run `pnpm dev` and choose "Dump to demo.json" in the share menu (dev-only option)
# After npm publish: npx vibe-replay
```

Output: `./vibe-replay/<slug>/index.html`

Quick intent map:
- Use `pnpm start` for final-user flow validation (fresh build + output HTML)
- Use `pnpm dev` for daily iteration (viewer + CLI together, choose "Dump to demo.json" dev-only option)
- Use `pnpm viewer:dev` when only touching UI
- Use `pnpm cli:dev` when only touching parser/CLI behavior
- Choose "Open in Editor" in CLI menu for annotation editing, HTML export, and gist publishing via local server

## Architecture

```
packages/cli/src/
├── index.ts                    # CLI entry
├── types.ts                    # Core types (Scene, ReplaySession, SessionInfo)
├── server.ts                   # Editor mode: Hono HTTP server (annotations, export, gist)
├── providers/                  # Provider adapters (pluggable)
│   ├── types.ts                # Provider interface
│   ├── index.ts                # Provider registry
│   ├── claude-code/            # Claude Code provider
│   │   ├── index.ts
│   │   ├── discover.ts         # Scan ~/.claude/projects/
│   │   └── parser.ts           # JSONL → ParsedTurn[]
│   └── cursor/                 # Cursor provider
│       ├── index.ts
│       ├── discover.ts         # Scan ~/.cursor/projects/ + detect store.db
│       ├── parser.ts           # JSONL fallback parser
│       └── sqlite-reader.ts    # SQLite store.db parser (primary)
├── transform.ts                # Provider-agnostic: turns → Scene[] + secret redaction
├── generator.ts                # Inject JSON into viewer HTML
└── publishers/                 # Publish targets
    ├── local.ts                # Open in browser
    └── gist.ts                 # Publish to GitHub Gist
```

### Adding a new provider
1. Create `providers/<name>/discover.ts` + `parser.ts` + `index.ts`
2. Implement the `Provider` interface from `providers/types.ts`
3. Register in `providers/index.ts`

## Key Architecture Decisions

- **Single HTML output**: viewer built to one file via vite-plugin-singlefile (~430KB), CLI injects `window.__VIBE_REPLAY_DATA__` JSON into `<head>` via `<script id="vibe-replay-data">`
- **`</` escaping**: JSON data in `<script>` MUST escape `</` as `<\/` (see generator.ts)
- **JSONL grouping**: Assistant messages split across multiple lines sharing same `message.id` — parser groups them. Tool results matched by `tool_use_id`
- **Cursor dual data source**: Primary: `~/.cursor/chats/<MD5(workspace_path)>/<session-uuid>/store.db` (SQLite with protobuf blob tree — has reasoning, tool-call, tool-result blocks). Fallback: `~/.cursor/projects/<path>/agent-transcripts/*.jsonl` (text-only, uses marker inference + `agent-tools/*.txt` mtime windows). Workspace hash = `MD5(absolute_workspace_path)`
- **`sql.js` for portability**: SQLite parsing uses sql.js (WASM) instead of native bindings — no C++ compiler needed, works everywhere via `npx`
- **`dataSource` metadata**: `ReplaySession.meta.dataSource` tracks which source was used (`sqlite`, `jsonl`, `jsonl+tools`) for diagnostics and transparency
- **Skip `progress` lines**: Subagent streaming artifacts
- **Provider adapter pattern**: Each IDE/tool has its own discover + parser, transform is shared
- **Package name `vibe-replay`**: CLI package name enables `npx vibe-replay` directly
- **CSS variables**: Light/dark themes powered by CSS vars (`--bg`, `--text`, etc.)
- **Secret redaction**: transform.ts strips API keys, tokens, PEM keys, DB connection strings, env vars with KEY/SECRET/TOKEN patterns
- **Path redaction**: transform.ts replaces user home dir with `~` in cwd, tool paths, bash commands
- **Multi-file sessions**: Claude Code `/resume` creates new JSONL files — CLI merges them by slug+project, `parse()` accepts `string | string[]`
- **URL loading**: Viewer supports `?url=<json-url>` and `?gist=<id>` via hosted viewer at vibe-replay.com
- **Gist republish UX**: CLI stores gist metadata per replay output folder (`.vibe-replay-gist.json`) so users can overwrite an existing gist on subsequent publishes
- **Editor mode**: "Open in Editor" starts a Hono localhost server (port 3456-3466) serving the viewer with `__VIBE_REPLAY_EDITOR__` flag. Viewer fetches session from `/api/session`, annotations POST to `/api/annotations` (debounced 1s) and persist to `{outputDir}/annotations.json`. Server also handles gist publishing and HTML export via API routes
- **ViewerMode**: Three-mode enum (`embedded | editor | readonly`) drives viewer behavior — embedded for self-contained HTML, editor for local server, readonly for `?gist=` / `?url=` URLs
- **Markdown rendering**: Uses `marked` (lightweight, ~37KB) instead of `react-markdown` + `remark-gfm` to keep viewer under 500KB

## Data Flow

```
~/.claude/projects/<path>/<session>.jsonl                          (Claude Code — JSONL)
~/.cursor/chats/<md5>/<uuid>/store.db                              (Cursor — SQLite, primary)
~/.cursor/projects/<path>/agent-transcripts/*.jsonl + agent-tools/  (Cursor — JSONL, fallback)
  → providers/<name>/parser.ts → ProviderParseResult (turns, timestamps, dataSource)
  → transform.ts → ReplaySession (scenes, redacted secrets + paths, metadata)
  → generator.ts → inject into viewer.html → vibe-replay/<slug>/index.html + replay.json
  → publishers/ → local (open browser) | gist (gh gist create → vibe-replay.com viewer)
  → server.ts → editor mode (localhost Hono server → viewer fetches /api/session, saves annotations via API)
```

Scene types: `user-prompt`, `thinking`, `text-response`, `tool-call`
Tool enrichment: Edit/Write → diff, Bash → command+stdout, screenshots → images, others → generic

## Replay Metadata

Both local HTML output and Gist output use the same `ReplaySession.meta` payload from `replay.json`.

Current `meta` fields include:
- `sessionId`, `slug`, `title`
- `provider`, `dataSource`
- `startTime`, `endTime`, `model`
- `cwd`, `project`
- `stats`: `sceneCount`, `userPrompts`, `toolCalls`, `thinkingBlocks`, `durationMs`, `tokenUsage`, `costEstimate`
- `compactions`: Array of context window compaction events

`ReplaySession` also has optional `annotations` array (id, sceneIndex, body, author, timestamps, resolved).

Current limitation:
- No generator metadata yet (e.g. CLI version, schema version, generated timestamp).

## Conventions

- Always use **pnpm**
- TypeScript strict mode, ESM throughout
- Viewer must remain < 500KB after build (currently ~430KB)
- Output HTML must be fully self-contained (no external requests)
- Test with real sessions from `~/.claude/projects/`
- Output path: `vibe-replay/<slug>/index.html`

## When Making Changes

- Viewer components changed → `pnpm build` (rebuilds both)
- CLI only changed → `pnpm --filter vibe-replay build` (or use tsx for dev)
- types.ts in CLI changed → manually sync `packages/viewer/src/types.ts` (they're duplicated)
- Test with both small (~30 scenes) and large (~500 scenes) sessions
- **After any change**: update this CLAUDE.md and README.md if anything becomes outdated
- **Before commit**: always perform a security review — check for leaked secrets, API keys, tokens, credentials, .env files in staged changes
- **Versions & releases**: NEVER autonomously bump versions, publish to npm, or create GitHub releases. Always ask the user for confirmation first.

## Self-Maintenance

Update this file when:
- New providers are added
- New publishers are added
- Architecture or data flow changes
- New scene types are added
- Build pipeline changes
- Important bugs or gotchas discovered

Keep it concise — reference, not documentation.
