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
- **Self-contained HTML**: Output must make zero automatic external requests. Viewer assets are inlined; remote replay images follow the explicit-consent rule below.
- **Remote replay images**: `ReplayImage` renders `data:image/*` sources immediately, but HTTP(S) images require an explicit per-image click and use `no-referrer`. Never attach an external URL to `<img src>` before consent.
- **Multi-file sessions**: Claude Code `/resume` creates new JSONL files. Parser accepts `string | string[]` and merges by slug+project.
- **Cursor tri-source**: Sessions come from SQLite `store.db` (primary), `globalStorage/state.vscdb`, or JSONL (fallback). Discovery merges all sources. DB data is source of truth; JSONL supplements missing thinking/images.
- **Cursor SDK**: SDK agents (TypeScript `@cursor/sdk`) write to `~/.cursor/projects/<workspace>/sdk-agent-store/<projectHash>/index.db` (tables: `agents`, `runs`, `run_events`) and a parallel JSONL transcript at `agent-transcripts/<agentId>/<agentId>.jsonl`. The transcript is the source of user prompts (SDK doesn't store them in events) and the SDK index.db supplies tool *results*, structured per-run timing, and per-turn model. See `packages/provider-cursor/src/cursor/sdk-reader.ts`. Detection is by sessionId prefix `agent-` — IDE chat sessions (UUID-only) skip the SDK SQLite probe. Newer stores add `runs.usage_json` (camelCase: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) and it is the only token source for SDK sessions; optional columns are probed with `PRAGMA table_info` so older stores still parse. Tool duration comes from the first/last `run_events.created_at` of a call. Tool enrichment pairs positionally but validates the tool name (Edit/Write/MultiEdit count as one family) and prefers a matching path/command, leaving a block unenriched rather than attaching another tool's result.
- **Cursor subagents**: IDE delegation trajectories live beside the parent transcript at `agent-transcripts/<sessionId>/subagents/<subAgentId>.jsonl`. Parent `Task`/`Subagent` calls do not carry the file ID, so `packages/provider-cursor/src/cursor/parser.ts` links them by normalized delegated-prompt containment and intentionally leaves unmatched files unattached rather than guessing by completion order. Current files contain tool calls and assistant text/reasoning, but usually no tool IDs/results, timestamps, token usage, or actual subagent model.
- **Cursor structured subagents**: Global-state `composer.composerHeaders` (stored in `ItemTable`) may identify child composers through `subagentInfo.parentComposerId/toolCallId`. Discovery hides those children from the top-level session list, and parsing links them to the exact parent `Agent` tool call. Structured IDs take precedence; transcript prompt containment remains the legacy fallback.
- **Cursor project paths**: `~/.cursor/projects/<encoded>` encodes the workspace path by replacing `/` with `-` **and dropping each segment's leading dot**, so `~/.cursor` arrives as `Users-me-cursor`. `decodeProjectDir` resolves the ambiguity by walking the real filesystem, trying `<candidate>` then `.<candidate>` at each level. The walk now returns the *deepest* directory it could confirm: once a real parent is found, everything left over is kept as one segment rather than split on `-`, because these workspaces are routinely deleted and splitting shredded their run ids (a scratch dir ending in a UUID became five path segments and a project named after the UUID's tail). Only when nothing below the root resolves does it fall back to replacing every `-` with `/`.
- **Agent run workspaces**: Automation creates one scratch workspace per run (Cursor SDK artifacts, PR-review worktrees, `/var/folders` temp dirs), each its own project. `agentRunWorkspaceParent` in `dashboard-utils.ts` spots a run id at the end of a directory name — a UUID or a hex digest of 12+ chars, short enough digests are left alone so `ros-4` and PR numbers don't match — and rolls the session up under the directory that holds it. `rollupProject` applies that alongside the Claude `.claude/worktrees` rule, so every surface gets it. Sessions, Replays, and Projects hide these workspaces by default (`agentRuns=true` in the URL shows them); the filter runs on the raw project path, since the rollup produces a parent that no longer looks like a run workspace.
- **Project identity**: `packages/types/src/project-identity.ts` is the shared classification layer for raw workspace paths. It preserves the generic run-id safeguards, recognizes Cursor SDK automation roots/workflows (including hyphen/underscore path variants), carries repository/PR metadata, and exposes canonical keys consumed by scanner aggregation and viewer rollups. Raw top-project entries remain available so the Projects `agentRuns=true` toggle can reveal individual workspaces.
- **Cursor duplicate transcripts**: Discovery coalesces duplicate transcript copies by session ID without adding their byte counts, and parsing removes identical records only across distinct files. Inline tool blocks are authoritative; mtime sidecars may fill unresolved tools but must not create duplicate calls.
- **Claude Cowork replay duplicates**: Cowork `audit.jsonl` can contain a host-loop user record plus an `isReplay: true` copy of the same prompt. Discovery excludes replay copies that match an original by content/UUID, and rich scans use the Cowork parser so dashboard prompt analytics match replay output.
- **Cowork `result` billing**: each `type: "result"` record is one completed host-loop run's final bill — `usage`, `modelUsage`, `total_cost_usd` and `duration_ms` are per-run, not cumulative. Session totals are the sum over UUID-deduplicated results; never mix them with assistant `message.usage` snapshots (those are partial streams and undercount output badly), and never add `usage` to `modelUsage` or `total_cost_usd` to `modelUsage.*.costUSD`. Audits with no `result` records fall back to assistant snapshots plus the timestamp-gap duration estimate. `system/api_retry` maps to `apiErrors` with attempt metadata only — the raw error text is never stored.
- **Provider-reported cost**: `ProviderParseResult.reportedCostUsd` wins over the local pricing table in `transform.ts`, which is what makes cost available for model generations `pricing.ts` does not know.
- **opencode**: Sessions live in a SQLite DB at `~/.local/share/opencode/opencode.db` (`%LOCALAPPDATA%\\opencode` on Windows, `OPENCODE_DATA` env var wins). Tables: `session`/`message`/`part`; role/user and tool payloads are JSON in `message.data`/`part.data`. Discovery writes `<dbPath>#session:<id>` marker paths. Parse is SQLite-backed (`parseSessionFromDb`), so background scan uses a lightweight path from discovery-computed stats (`buildLightweightOpencodeScanResult` in `scanner.ts`) to avoid opening the DB per session. `sql.js` named-param binds need their `:`-prefix in the key — this provider uses positional `?` params instead. The `session.cost` column (populated only by some opencode versions) feeds `reportedCostUsd` when positive. See `packages/provider-opencode/`.
- **Hermes**: Sessions live in SQLite at `~/.hermes/state.db` (FTS5-backed), plus one DB per named profile at `~/.hermes/profiles/<name>/state.db`. Discovery scans all of them (`hermesDbPaths()` in `packages/provider-hermes/src/hermes/sqlite.ts`), dedups by session id, and writes `<dbPath>#session:<id>` marker paths; parse resolves the right DB from the marker before falling back to a scan. `hermesRootDir()` mirrors Hermes's `get_default_hermes_root()`: `HERMES_HOME` inside `~/.hermes` is profile mode (root stays `~/.hermes`); outside it, that path itself is the root. Caveat: sql.js reads raw file bytes and cannot replay un-checkpointed `-wal` frames, so sessions still sitting in the WAL (long-running gateway) are invisible until Hermes checkpoints. Tables: `sessions` (token/cost/git columns maintained by Hermes) + `messages` (OpenAI-style: assistant rows carry `tool_calls` JSON + `reasoning`; tool rows carry `tool_name` + `tool_call_id` + result content). Discovery writes `<dbPath>#session:<id>` marker paths and reads `~/.hermes/.update_check` for the version. Context compaction is recorded two ways: `compacted=1` rows (pre-compaction history, kept in full) and a user row prefixed `[CONTEXT COMPACTION` (→ `subtype: "compaction-summary"`, mirroring claude-code); every `compacted=1` run boundary emits its own compaction event, and discovery excludes those marker rows from prompt counts and firstPrompt. Provider cost: `reportedCostUsd` comes from `sessions.actual_cost_usd`, falling back to `estimated_cost_usd` when positive (`cost_status` "included"/"unknown" store 0). Parse is SQLite-backed, so background scan uses `buildLightweightHermesScanResult` in `scanner.ts`. Tool names map to the viewer vocabulary in `tool-mapping.ts`. See `packages/provider-hermes/`.
- **Skip `progress` lines**: These are subagent streaming artifacts in JSONL.
- **sql.js (WASM)**: Used instead of native SQLite bindings for portability — no C++ compiler needed.
- **Session discovery cache**: CLI picker + local dashboard use file cache at `~/.vibe-replay/cache/*.json` (stale-while-refresh UX). Cache validity is tied to CLI release version (`CLI_VERSION`) plus envelope version, so caches auto-invalidate across releases. Keep cache writes best-effort and never block generation/parsing on cache failures.
- **Windows support**: Cursor encodes workspace dirs as `C:\a\b` → `C-a-b` (drive colon dropped, separators → `-`); `decodeProjectDir` has a `win32` branch that resolves these against the real filesystem (POSIX uses `/` root, Windows uses the drive root). Cursor on Windows stores IDE chats only in the `globalStorage/state.vscdb` under `%APPDATA%\Cursor` (there is no `~/.cursor/chats` dir). Replay output normalizes file paths to `/` for cross-platform display via `redactFilePath` in `transform.ts` — never apply that to prose. Build scripts shell out to `scripts/copy-file.mjs` instead of `mkdir -p`/`cp` (not available in PowerShell). `.gitattributes` forces `eol=lf` so Windows clones don't trip `oxfmt --check` with CRLF.
- **Pi harness tools**: Pi sessions use both native tool names (`bash`, `edit`, `write`) and harness names (`exec_command`, `apply_patch`). The Pi provider maps `exec_command` to replay `Bash` and parses `apply_patch` into replay `Edit` inputs (including all touched `file_paths`, with the first file represented by the single-diff viewer). Harness tools report failure through `details.exit_code` rather than the `isError` flag native tools use, so a non-zero exit code marks the result as an error. Native `edit` can carry several replacements; all of them are joined into the single `old_string`/`new_string` diff the viewer renders, and the tool stays named `Edit`.
- **Pi token accounting**: `compaction` and `branch_summary` entries carry the usage of a *separate* summarization call, so their `usage` adds to session totals (matching Pi's own billed totals). `tokensBefore` is context size, not usage, and only feeds `compactions[].preTokens`. Summary usage never enters `turnStats`. Session `model` is the last selected model, which is what discovery reports.
- **Usage index (tool / MCP / skill)**: `scanner.ts` derives one `UsageEvent` per invocation (name, turn, timestamp, duration, status, subagent) plus a per-session `SessionUsageSummary`; only the latest 100 detail events are retained, and tool inputs/results are never stored. MCP naming differs per provider and is normalized in `parseMcpUsage`: `mcp__<server>__<tool>` (Claude/Codex), `CallMcpTool {server, toolName}` (Cursor SDK), `mcp-<server>-<tool>` (Cursor IDE — split at the *last* dash because server IDs are kebab-case, and the normalized input's `server`/`tool_name` wins), `mcp_<server>_<tool>` (older Cursor — split at the *first* underscore because tool names are snake_case, with `mcp_auth`/`mcp_get_tools`/`mcp_meta_tool*` excluded as MCP management tools), and Pi's single `mcp` tool (`server` field, or `<server>_<tool>` in `tool`). An MCP call is counted under `mcpServers`/`mcpTools` only — never also as a tool — so the Tool facet lists real tools instead of repeating the MCP facets. Cowork names servers by UUID, so its parser exposes `mcpServerNames` from the sibling `local_{id}.json` `remoteMcpServersConfig`. OpenCode/Hermes and deferred Cursor scans emit no usage events — they say so in `dataQualityNotes` rather than looking like zero usage. Cursor reports the same server under several ids (`user-<name>`, `<name>::mcpScope:profile:...:cfg:...`); `stripCursorServerScope` folds them so one server is one facet. `/api/scan/results` strips events; per-session events come from `/api/usage/events`, and `/api/usage/rollup` serves the compact per-session `{ startTime, usage }` projection the Insights page aggregates client-side (`engine/usage-rollup.ts`, range-filtered by instant so switching 7d/30d/90d costs no request). The dashboard renders Tool and MCP server facets plus a per-session breakdown (`engine/session-usage.ts`) built from the summary alone, so expanding a card costs no request; the MCP tool facet is a drilldown that only appears once a server or tool is selected, and long facet lists scroll inside their section so the ones below stay reachable. The scan-results cache key carries `SCANNER_VERSION`, so a bump can't serve results in the previous shape. Insights renders a "Tools & MCP" card (top tools / MCP servers / MCP tools / skills, each with calls and session reach). Cursor SQLite sessions are scanned twice: a fast pass with rich parsing deferred, then a background `backfillDeferredUsage` pass in `server.ts` that indexes their usage and rewrites the scan cache (progress in `/api/scan/status` as `usageBackfill`).

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
