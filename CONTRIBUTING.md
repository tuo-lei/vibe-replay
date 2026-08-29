# Contributing to vibe-replay

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Setup

```bash
git clone https://github.com/tuo-lei/vibe-replay.git
cd vibe-replay
pnpm install
pnpm build
```

Requires Node.js >= 22.19.0 and pnpm.
Website scripts use Astro 6 and require Node.js >= 22.12.0 inside `website/`. When `nvm` is available, they will try `nvm use` from `website/.nvmrc` automatically.

Before running the repository commands, verify the Node runtime used by the
package manager as well as the shell default:

```bash
node -v
corepack pnpm exec node -v
```

Both versions must be at least `22.19.0`. Some global package-manager shims
(notably a Volta-pinned `pnpm`) can run `pnpm exec` under an older globally
pinned Node even when `node -v` is newer. If the versions differ, select Node
22.19.0 or newer with your version manager and use `corepack pnpm ...` (or
reinstall/re-pin pnpm for that Node) until both checks agree.

## Development

```bash
pnpm dev              # Viewer (Vite HMR) + CLI (tsx watch, auto-restart)
pnpm dev:dashboard    # Same as above, opens dashboard directly
pnpm dev:website      # Website (Astro HMR) + Viewer (Vite HMR)
pnpm test             # Run tests
pnpm verify           # Sequential pre-PR validation
pnpm start            # Full build + run (simulates real user flow)
```

**Testing viewer hooks/components**: most viewer tests run in the default node
environment (pure engine/util logic). Tests that render React (hooks via
`renderHook`, components via `render` from `@testing-library/react`) opt into a
DOM by adding `// @vitest-environment jsdom` as the first line of the test file,
and should `afterEach(cleanup)` so window listeners don't leak between tests.
See `src/hooks/__tests__/usePlayback.test.tsx` for the pattern.

**Daily workflow**: Run `pnpm dev`, open `http://localhost:5173`. Viewer changes hot-reload instantly via Vite HMR. CLI/API changes auto-restart via `tsx watch`. No manual rebuild or restart needed.

## Architecture

pnpm monorepo with shared foundations, provider packages, and app layers:

- **`packages/types`** — Shared TypeScript types (`@vibe-replay/types`). Both CLI and viewer re-export from here.
- **`packages/provider-contract` / `provider-core`** — Stable provider interfaces and shared discovery/parser utilities.
- **`packages/provider-*`** — Provider-owned discovery and parsing for Claude, Codex, Cursor, OpenCode, Hermes, and Pi.
- **`packages/providers-default`** — Default provider registry and cross-provider discovery deduplication.
- **`packages/replay-core`** — Provider-neutral scene transformation, redaction, token estimates, and pricing.
- **AI Studio** — `packages/cli/src/ai-runtime.ts` embeds Pi's provider/auth runtime and
  `packages/cli/src/feedback.ts` runs structured Coach, Translate, and Tone jobs through Pi Agent Core.
  `packages/viewer/src/components/AiProviderSettings.tsx` is the shared provider settings surface:
  it renders inline in global Settings and inside the AI Studio Manage Providers modal. The editor
  also supports a user-configured OpenAI-compatible endpoint: endpoint metadata is stored in a
  separate restricted file, its API key remains in the credential store, and dynamic models are
  discovered from `/models` (with a `/model` fallback). Model selection uses the shared searchable
  picker and a browser-local remembered selection; it must not be written to replay data or
  credentials.
- **Ask Replay** — `packages/cli/src/local-assistant.ts` exposes bounded, read-only session, replay,
  scene, usage, insight, and navigation tools to the local assistant. `packages/cli/src/server.ts`
  owns the SSE transport and provider-selection boundary; no shell, filesystem, arbitrary network,
  publishing, or mutation tools are exposed. SSH content requires explicit per-request consent.
- **`packages/cli`** — CLI tool published as `vibe-replay` on npm. Discovers sessions, generates replays, and serves the local dashboard/editor.
- **`packages/viewer`** — React app built into a single HTML file (~1.0MB) via `vite-plugin-singlefile`. Handles playback, annotations, insights, theming, and search.

### Data flow

```
Session files (JSONL / SQLite)
  → provider-*/discover.ts       find sessions on disk
  → provider-*/parser.ts         parse into ParsedTurn[]
  → replay-core/transform.ts     convert to Scene[], redact secrets/paths
  → cli/generator.ts             inject JSON into viewer HTML
  → output                       vibe-replay/<slug>/index.html + replay.json
```

Configured SSH sources add a transport step before the same provider flow:
`packages/cli/src/remote.ts` uses the system OpenSSH client to list and
materialize remote Codex, Claude Code, or Pi JSONL files in a per-target cache
with manifest-sized transfer limits.
Provider names and `DataSource` values remain independent from the session's
`SessionLocation`. Codex `/resume` titles prefer explicit names from
`session_index.jsonl`, then fall back to `state_5.sqlite` through a read-only
Python `sqlite3` query or schema-aware `sqlite3` CLI fallback; the live database
and WAL are never copied. A metadata-only or unreadable source is
retained in the catalog with `no-prompts` or `unreadable` status and is not
eligible for generation. Remote git repository identity supports local filters
but is removed from share and export payloads. Remote sessions can feed local dashboard insights,
but are excluded from the optional cloud insight aggregate sync. Remote Live
mode is deliberately disabled.

### Dashboard terminology and caches

The dashboard uses product terminology that distinguishes original AI sessions from generated replays:

- **Sessions** in the UI are **Source Sessions**: raw/discovered AI coding sessions from providers such as Claude, Cursor, Codex, OpenCode, Hermes, and Pi. They may or may not have a generated replay yet.
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
├── ai-runtime.ts         # Embedded Pi provider/auth runtime for AI Studio
├── server.ts             # Editor mode: Hono localhost server
├── feedback.ts           # AI Coach integration
├── scan.ts               # Secret detection in output
├── clean-prompt.ts       # Strip system boilerplate from prompts
├── version.ts            # CLI_VERSION from package.json
├── providers/
│   ├── types.ts          # CLI provider compatibility types
│   ├── index.ts          # Provider registry bridge
│   └── pi/               # Pi session discovery and parser adapters
└── publishers/
    ├── local.ts          # Open in browser
    └── gist.ts           # GitHub Gist publishing
```

Provider-owned discovery and parsing lives in the top-level `packages/provider-*` packages;
the CLI's `src/providers/` directory retains app-specific adapters used by the server and
legacy parsing paths.

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

1. Create `packages/provider-<name>/src/<name>/discover.ts` — scan disk for sessions, return `SessionInfo[]`
2. Create `packages/provider-<name>/src/<name>/parser.ts` — parse files into `ParsedTurn[]`
3. Create `packages/provider-<name>/src/<name>/index.ts` — implement the `Provider` interface
4. Register the provider in `packages/providers-default/src/index.ts`
5. Add the package test command to the root `pnpm test` chain

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
- **Viewer bundle**: The viewer is shipped as a self-contained HTML artifact; there is no hard size cap. Keep an eye on bundle size and runtime performance as features grow.
- **Output HTML must be fully self-contained** — no automatic external requests; remote media requires explicit user consent
- **Shared types** live in `packages/types` (`@vibe-replay/types`) — CLI and viewer re-export from there
- **Secret redaction**: `transform.ts` strips API keys, tokens, PEM keys, paths. `scan.ts` does a second pass on the final output.
- **`</` escaping**: JSON in `<script>` tags must escape `</` as `<\/` (see `generator.ts`)
- **Error handling** — pick one of three, deliberately:
  - **Propagate** when the caller can't proceed without the result (let it throw).
  - **Log** when a step can be skipped but the failure is diagnostically useful — e.g. one provider failing during discovery shouldn't abort the others, but should be visible under `VIBE_REPLAY_DEBUG` (the dashboard stays quiet by default).
  - **Silently swallow** only for genuinely-expected, recoverable cases (an optional file that may be absent, a best-effort cache write). Every such empty `catch` **must carry a one-line comment** explaining why it's safe to ignore — a bare `catch {}` is not allowed.

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes and run `pnpm verify`
3. Run `pnpm test:e2e` when the change affects generated HTML, the editor server, CLI flows, or auth
4. Test viewer behavior with both small (~30 scenes) and large (~500 scenes) sessions when relevant
5. Open a pull request against `main`

`pnpm verify` runs lint, strict TypeScript checks, unit tests, Cloudflare tests, and the production build sequentially. Keep these stages sequential locally: running the full suites concurrently can starve timing-sensitive integration tests.

Please don't bump versions or publish — releases are handled by maintainers.

## Reporting issues

Open an issue at [github.com/tuo-lei/vibe-replay/issues](https://github.com/tuo-lei/vibe-replay/issues). Include:

- What you expected vs what happened
- Steps to reproduce
- Provider (Claude Code / Cursor) and OS
