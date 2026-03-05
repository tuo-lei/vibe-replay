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
pnpm dev                   # Dev mode (uses tsx, no build)
pnpm test                  # Run tests
npx tsx packages/cli/src/index.ts -s <path> --dev  # Write demo.json for HMR
# After npm publish: npx vibe-replay
```

Output: `./vibe-replay/<slug>/index.html`

## Architecture

```
packages/cli/src/
├── index.ts                    # CLI entry
├── types.ts                    # Core types (Scene, ReplaySession, SessionInfo)
├── providers/                  # Provider adapters (pluggable)
│   ├── types.ts                # Provider interface
│   ├── index.ts                # Provider registry
│   ├── claude-code/            # Claude Code provider
│   │   ├── index.ts
│   │   ├── discover.ts         # Scan ~/.claude/projects/
│   │   └── parser.ts           # JSONL → ParsedTurn[]
│   └── cursor/                 # Cursor provider
│       ├── index.ts
│       ├── discover.ts         # Scan ~/.cursor/projects/
│       └── parser.ts           # JSONL → ParsedTurn[]
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

- **Single HTML output**: viewer built to one file via vite-plugin-singlefile (~480KB), CLI injects `window.__VIBE_REPLAY_DATA__` JSON into `<head>`
- **`</` escaping**: JSON data in `<script>` MUST escape `</` as `<\/` (see generator.ts)
- **JSONL grouping**: Assistant messages split across multiple lines sharing same `message.id` — parser groups them. Tool results matched by `tool_use_id`
- **Skip `progress` lines**: Subagent streaming artifacts
- **Provider adapter pattern**: Each IDE/tool has its own discover + parser, transform is shared
- **Package name `vibe-replay`**: CLI package name enables `npx vibe-replay` directly
- **CSS variables**: Light/dark themes powered by CSS vars (`--bg`, `--text`, etc.)
- **Secret redaction**: transform.ts strips API keys, tokens, PEM keys, DB connection strings, env vars with KEY/SECRET/TOKEN patterns
- **Path redaction**: transform.ts replaces user home dir with `~` in cwd, tool paths, bash commands
- **Multi-file sessions**: Claude Code `/resume` creates new JSONL files — CLI merges them by slug+project, `parse()` accepts `string | string[]`
- **URL loading**: Viewer supports `?url=<json-url>` and `?gist=<id>` via hosted viewer at vibe-replay.com

## Data Flow

```
~/.claude/projects/<path>/<session>.jsonl   (Claude Code)
~/.cursor/projects/<path>/agent-transcripts/*.jsonl  (Cursor)
  → providers/<name>/parser.ts → ProviderParseResult (grouped turns, timestamps, images)
  → transform.ts → ReplaySession (scenes, redacted secrets + paths)
  → generator.ts → inject into viewer.html → vibe-replay/<slug>/index.html + replay.json
  → publishers/ → local (open browser) | gist (gh gist create → vibe-replay.com viewer)
```

Scene types: `user-prompt`, `thinking`, `text-response`, `tool-call`
Tool enrichment: Edit/Write → diff, Bash → command+stdout, screenshots → images, others → generic

## Conventions

- Always use **pnpm**
- TypeScript strict mode, ESM throughout
- Viewer must remain < 500KB after build (currently ~480KB)
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
