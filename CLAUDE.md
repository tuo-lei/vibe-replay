# CLAUDE.md — vibe-replay

## What is this

vibe-replay turns AI coding sessions into animated, interactive web replays as self-contained HTML files. Supports Claude Code and Cursor.

pnpm monorepo: `packages/cli` (npm: `vibe-replay`), `packages/viewer` (React → single HTML), `packages/types` (shared types), `website/` (Astro), `cloudflare/` (Workers API).

## Commands

```bash
pnpm install               # Install deps
pnpm build                 # Full build: viewer → cli
pnpm start                 # Build + run interactive picker
pnpm dev                   # Viewer (Vite HMR) + CLI together
pnpm viewer:dev            # Viewer only
pnpm cli:dev               # CLI only (tsx)
pnpm test                  # Run tests
pnpm lint                  # Lint + format (auto-fix)
pnpm lint:check            # Lint check (no fix, for CI)
pnpm dev:dashboard         # Dev mode with dashboard flag (-d)
```

When to use which:
- `pnpm start` — validate full user flow
- `pnpm dev` — daily iteration (choose "Dump to demo.json", open `localhost:5173/?file=/demo.json`)
- `pnpm viewer:dev` — UI-only changes
- `pnpm cli:dev` — parser/CLI-only changes

## Gotchas

- **`</` escaping**: JSON in `<script>` tags MUST escape `</` as `<\/` — browsers close the tag otherwise (see `generator.ts`)
- **`lastIndexOf("</head>")`**: Use `lastIndexOf`, not `indexOf` — minified JS in the viewer bundle may contain the string `</head>`
- **Shared types**: `Scene`, `Annotation`, `DataSourceInfo`, `ReplaySession` live in `packages/types` (`@vibe-replay/types`). CLI and viewer re-export from there. Provider-specific and viewer-specific types remain in their respective packages.
- **Viewer size limit**: Must stay under 500KB after build (currently ~430KB). This is why we use `marked` instead of `react-markdown`.
- **Self-contained HTML**: Output must make zero external requests. Everything inlined.
- **Multi-file sessions**: Claude Code `/resume` creates new JSONL files. Parser accepts `string | string[]` and merges by slug+project.
- **Cursor tri-source**: Sessions come from SQLite `store.db` (primary), `globalStorage/state.vscdb`, or JSONL (fallback). Discovery merges all sources. DB data is source of truth; JSONL supplements missing thinking/images.
- **Skip `progress` lines**: These are subagent streaming artifacts in JSONL.
- **sql.js (WASM)**: Used instead of native SQLite bindings for portability — no C++ compiler needed.

## Rules

- **Always use pnpm** — never npm/yarn
- **TypeScript strict mode**, ESM throughout
- **Biome** for linting + formatting — runs automatically via PostToolUse hook and pre-commit hook
- **Before commit**: run `pnpm lint:check` and fix any errors. Do NOT commit code that fails lint.
- **Before commit**: security review — check for leaked secrets, API keys, tokens, credentials, .env files
- **Never bump versions or publish** without explicit user confirmation
- **After changes**: update CLAUDE.md / README.md / CONTRIBUTING.md if anything becomes outdated
- **Viewer changes** → `pnpm build` (rebuilds both packages)
- **CLI-only changes** → `pnpm --filter vibe-replay build`
- **Shared types changes** → edit `packages/types/src/index.ts`, both CLI and viewer pick them up automatically
- Test with both small (~30 scenes) and large (~500 scenes) sessions
- **Test modification policy** — see `packages/cli/test/README.md` before changing any test

## Key files

| What | Where |
|------|-------|
| CLI entry | `packages/cli/src/index.ts` |
| Shared types | `packages/types/src/index.ts` |
| CLI types | `packages/cli/src/types.ts` |
| Transform (turns → scenes) | `packages/cli/src/transform.ts` |
| HTML generation | `packages/cli/src/generator.ts` |
| Editor server | `packages/cli/src/server.ts` |
| Provider interface | `packages/cli/src/providers/types.ts` |
| Viewer entry | `packages/viewer/src/App.tsx` |
| Playback engine (pure) | `packages/viewer/src/engine/` |
| Playback hook | `packages/viewer/src/hooks/usePlayback.ts` |
| Session loading | `packages/viewer/src/hooks/useSessionLoader.ts` |
| View preferences | `packages/viewer/src/hooks/useViewPrefs.ts` |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for full architecture details.
