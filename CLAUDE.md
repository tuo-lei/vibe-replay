# CLAUDE.md — vibe-replay

## What is this

vibe-replay turns AI coding sessions into animated, interactive web replays as self-contained HTML files. Supports Claude Code, Cursor, Codex, OpenCode, and Hermes.

pnpm monorepo: `packages/cli` (npm: `vibe-replay`), `packages/viewer` (React → single HTML), `packages/types` (shared types), `website/` (Astro), `cloudflare/` (Workers API).

## Commands

```bash
pnpm install               # Install deps
pnpm build                 # Full build: viewer → cli
pnpm start                 # Build + run interactive picker
pnpm dev                   # Viewer (Vite HMR) + CLI (tsx watch) together
pnpm dev:dashboard         # Dev mode with dashboard flag (-d)
pnpm dev:website           # Website (Astro HMR) + Viewer (Vite HMR) together
pnpm test                  # Run unit tests
pnpm test:e2e              # Run E2E tests (requires pnpm build first)
pnpm lint                  # Lint + format (auto-fix)
pnpm lint:check            # Lint check (no fix, for CI)
```

When to use which:
- `pnpm start` — validate full user flow (build + run)
- `pnpm dev` — daily iteration with full HMR: viewer auto-reloads via Vite, CLI auto-restarts via `tsx watch`
- `pnpm dev:website` — website + viewer iteration: Astro HMR + `/view/` redirects to Vite viewer

## Database (D1 + Drizzle)

Schema is managed by **Drizzle ORM** — single source of truth in `cloudflare/src/db/schema.ts`.

**When you change the schema:**
```bash
cd cloudflare
pnpm db:generate          # Drizzle reads schema.ts, generates SQL migration in drizzle/
pnpm db:migrate:local     # Apply to local D1
pnpm db:migrate:remote    # Apply to production D1 (requires auth)
```

- All tables (replays + Better Auth auth tables) are defined in `cloudflare/src/db/schema.ts`
- Migration files live in `cloudflare/drizzle/` — commit them to git
- **Never hand-edit migration files** — always use `drizzle-kit generate`
- `schema.sql` is kept as a reference but migrations are the source of truth
- Better Auth uses `drizzleAdapter` — it reads/writes auth tables through the same Drizzle instance

## Gotchas

- **`</` escaping**: JSON in `<script>` tags MUST escape `</` as `<\/` — browsers close the tag otherwise (see `generator.ts`)
- **`lastIndexOf("</head>")`**: Use `lastIndexOf`, not `indexOf` — minified JS in the viewer bundle may contain the string `</head>`
- **Shared types**: `Scene`, `Annotation`, `DataSourceInfo`, `ReplaySession` live in `packages/types` (`@vibe-replay/types`). CLI and viewer re-export from there. Provider-specific and viewer-specific types remain in their respective packages.
- **Viewer size limit**: Keep under 1MB after build (current build is ~915KB on Tailwind v4). This is why we use `marked` instead of `react-markdown`. Watch for size regressions when adding features.
- **Viewer styling**: Tailwind **v4** via the `@tailwindcss/vite` plugin (no `postcss.config`/autoprefixer). The terminal theme lives in `packages/viewer/tailwind.config.js`, loaded from `src/styles/index.css` via `@config` (v4's legacy-config bridge). The website is also on v4.
- **Self-contained HTML**: Output must make zero external requests. Everything inlined.
- **Multi-file sessions**: Claude Code `/resume` creates new JSONL files. Parser accepts `string | string[]` and merges by slug+project.
- **Cursor tri-source**: Sessions come from SQLite `store.db` (primary), `globalStorage/state.vscdb`, or JSONL (fallback). Discovery merges all sources. DB data is source of truth; JSONL supplements missing thinking/images.
- **Cursor SDK**: SDK agents (TypeScript `@cursor/sdk`) write to `~/.cursor/projects/<workspace>/sdk-agent-store/<projectHash>/index.db` (tables: `agents`, `runs`, `run_events`) and a parallel JSONL transcript at `agent-transcripts/<agentId>/<agentId>.jsonl`. The transcript is the source of user prompts (SDK doesn't store them in events) and the SDK index.db supplies tool *results*, structured per-run timing, and per-turn model. See `packages/provider-cursor/src/cursor/sdk-reader.ts`. Detection is by sessionId prefix `agent-` — IDE chat sessions (UUID-only) skip the SDK SQLite probe.
- **Cursor subagents**: IDE delegation trajectories live beside the parent transcript at `agent-transcripts/<sessionId>/subagents/<subAgentId>.jsonl`. Parent `Task`/`Subagent` calls do not carry the file ID, so `packages/provider-cursor/src/cursor/parser.ts` links them by normalized delegated-prompt containment and intentionally leaves unmatched files unattached rather than guessing by completion order. Current files contain tool calls and assistant text/reasoning, but usually no tool IDs/results, timestamps, token usage, or actual subagent model.
- **opencode**: Sessions live in a SQLite DB at `~/.local/share/opencode/opencode.db` (`%LOCALAPPDATA%\\opencode` on Windows, `OPENCODE_DATA` env var wins). Tables: `session`/`message`/`part`; role/user and tool payloads are JSON in `message.data`/`part.data`. Discovery writes `<dbPath>#session:<id>` marker paths. Parse is SQLite-backed (`parseSessionFromDb`), so background scan uses a lightweight path from discovery-computed stats (`buildLightweightOpencodeScanResult` in `scanner.ts`) to avoid opening the DB per session. `sql.js` named-param binds need their `:`-prefix in the key — this provider uses positional `?` params instead. See `packages/provider-opencode/`.
- **Hermes**: Sessions live in SQLite at `~/.hermes/state.db` (FTS5-backed). Tables: `sessions` (token/cost/git columns maintained by Hermes) + `messages` (OpenAI-style: assistant rows carry `tool_calls` JSON + `reasoning`; tool rows carry `tool_name` + `tool_call_id` + result content). Discovery writes `<dbPath>#session:<id>` marker paths and reads `~/.hermes/.update_check` for the version. Context compaction is recorded two ways: `compacted=1` rows (pre-compaction history, kept in full) and a user row prefixed `[CONTEXT COMPACTION` (→ `subtype: "compaction-summary"`, mirroring claude-code). Parse is SQLite-backed, so background scan uses `buildLightweightHermesScanResult` in `scanner.ts`. Tool names map to the viewer vocabulary in `tool-mapping.ts`. See `packages/provider-hermes/`.
- **Skip `progress` lines**: These are subagent streaming artifacts in JSONL.
- **sql.js (WASM)**: Used instead of native SQLite bindings for portability — no C++ compiler needed.
- **Session discovery cache**: CLI picker + local dashboard use file cache at `~/.vibe-replay/cache/*.json` (stale-while-refresh UX). Cache validity is tied to CLI release version (`CLI_VERSION`) plus envelope version, so caches auto-invalidate across releases. Keep cache writes best-effort and never block generation/parsing on cache failures.
- **Windows support**: Cursor encodes workspace dirs as `C:\a\b` → `C-a-b` (drive colon dropped, separators → `-`); `decodeProjectDir` has a `win32` branch that resolves these against the real filesystem (POSIX uses `/` root, Windows uses the drive root). Cursor on Windows stores IDE chats only in the `globalStorage/state.vscdb` under `%APPDATA%\Cursor` (there is no `~/.cursor/chats` dir). Replay output normalizes file paths to `/` for cross-platform display via `redactFilePath` in `transform.ts` — never apply that to prose. Build scripts shell out to `scripts/copy-file.mjs` instead of `mkdir -p`/`cp` (not available in PowerShell). `.gitattributes` forces `eol=lf` so Windows clones don't trip `oxfmt --check` with CRLF.

## Rules

- **Always use pnpm** — never npm/yarn
- **TypeScript strict mode**, ESM throughout
- **oxlint** for linting, **oxfmt** for formatting — both run automatically via PostToolUse hook and pre-commit hook
- **Before commit**: run `pnpm lint:check` and fix any errors. Do NOT commit code that fails lint.
- **Before commit**: security review — check for leaked secrets, API keys, tokens, credentials, .env files
- **Never bump versions or publish** without explicit user confirmation
- **After changes**: update CLAUDE.md / README.md / CONTRIBUTING.md if anything becomes outdated
- **Viewer changes** → `pnpm build` (rebuilds both packages)
- **CLI-only changes** → `pnpm --filter vibe-replay build`
- **Shared types changes** → edit `packages/types/src/index.ts`, both CLI and viewer pick them up automatically
- Test with both small (~30 scenes) and large (~500 scenes) sessions
- **Test modification policy** — see `packages/cli/test/README.md` before changing any test

## Release checklist (important)

When creating a release for npm/GitHub, do this in order:

1. Confirm with user first (no autonomous publish/version bump).
2. Bump `packages/cli/package.json` `version` to the target release version.
3. Build CLI: `pnpm --filter vibe-replay build`.
4. Verify displayed CLI version matches package version:
   - `node packages/cli/dist/index.js --version`
   - Note: startup banner `vX.Y.Z` comes from `packages/cli/src/version.ts` reading `packages/cli/package.json`.
5. Only then create tag/release/publish for that same version.

If tag/release is updated but `packages/cli/package.json` is not, CLI will still show the old version.

## Key files

| What | Where |
|------|-------|
| CLI entry | `packages/cli/src/index.ts` |
| Shared types | `packages/types/src/index.ts` |
| CLI types | `packages/cli/src/types.ts` |
| Transform (turns → scenes) | `packages/cli/src/transform.ts` |
| HTML generation | `packages/cli/src/generator.ts` |
| Editor server | `packages/cli/src/server.ts` |
| Provider interface | `packages/provider-contract/src/index.ts` (contract) / `packages/providers-default/src/index.ts` (registry) |
| Cursor SDK reader | `packages/provider-cursor/src/cursor/sdk-reader.ts` |
| opencode provider | `packages/provider-opencode/src/opencode/` |
| Hermes provider | `packages/provider-hermes/src/hermes/` |
| Viewer entry | `packages/viewer/src/App.tsx` |
| Playback engine (pure) | `packages/viewer/src/engine/` |
| Playback hook | `packages/viewer/src/hooks/usePlayback.ts` |
| Session loading | `packages/viewer/src/hooks/useSessionLoader.ts` |
| View preferences | `packages/viewer/src/hooks/useViewPrefs.ts` |
| DB schema (all tables) | `cloudflare/src/db/schema.ts` |
| Auth config | `cloudflare/src/auth.ts` |
| Worker (Hono routes) | `cloudflare/src/worker.ts` |
| Drizzle config | `cloudflare/drizzle.config.ts` |
| Drizzle migrations | `cloudflare/drizzle/` |
| E2E test helpers | `e2e/helpers.ts` |
| E2E: generated HTML | `e2e/generated-html.test.ts` |
| E2E: editor server | `e2e/editor-server.test.ts` |
| E2E: CLI smoke | `e2e/cli-smoke.test.ts` |
| E2E: auth worker | `e2e/auth-worker.test.ts` |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for full architecture details.
