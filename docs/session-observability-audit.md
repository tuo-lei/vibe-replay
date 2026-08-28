# Session observability audit

vibe-replay has two different responsibilities:

1. Preserve enough of a session to replay what happened.
2. Produce a privacy-bounded index that an agent can query without loading the
   full transcript.

These are related, but they are not the same coverage claim. The dashboard
therefore reports scan completion, metric availability, and metric quality
separately in the **Insights → Coverage** section.

## Canonical metric definitions

- `inputTokens` is uncached input after provider-specific normalization.
- `promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens`.
- `cacheMissTokens = inputTokens + cacheCreationTokens`.
- `cacheReadShare = cacheReadTokens / promptTokens`.
- “Uncached / miss” is derived. There is no provider-independent cache-miss
  counter, so it must not be presented as an exact billing field.
- Invocation counts are one event per concrete tool call. MCP calls are removed
  from the ordinary-tool facet and counted under their server; named MCP tools
  are measured separately from server-only calls.
- A completed index with zero invocations is valid evidence of zero calls. It is
  different from a deferred or failed index.
- Cursor compaction counts are lower bounds: Cursor persists the latest
  conversation summary rather than an append-only compaction event log.

## Provider matrix

| Provider | Source | Tools / MCP | Tokens / cache | Compaction |
| --- | --- | --- | --- | --- |
| Claude Code / Desktop | JSONL, grouped by assistant message ID | Exact pairing; MCP attribution is propagated across streamed fragments | Provider-reported; cache read/write fields preserved | `compact_boundary` and summary records |
| Claude Cowork | `audit.jsonl` plus run-level result records | Exact where tool attribution is present; UUID server names are resolved from sibling metadata | Run-level billing is preferred over streaming snapshots | Claude-compatible boundary records |
| Codex | Rollout JSONL plus state metadata | Includes orphan and serverless MCP completions; server/tool naming is explicit when available | `input_tokens - cached_input_tokens`, cached portion preserved as read-only | `context_compacted`, `compacted`, and response-item variants |
| Cursor | JSONL, `store.db`, global state, SDK index | Structured calls are deduplicated; unknown MCP server/tool calls remain visible | Snapshot-derived and therefore estimated; missing snapshots remain visible as missing | Latest persisted summary; lower bound |
| OpenCode | SQLite `session`, `message`, and `part` rows | Completed/error tool parts are retained and repeated call parts are deduplicated | Provider message usage, including cache read/write | User compaction parts, deduplicated by message |
| Hermes | SQLite session/model/message rows | Native tool calls paired by call ID; skill activation separated from skill management | Provider session/model usage | Compacted run boundaries and summary markers |
| Pi | Active JSONL branch | Tool results paired by call ID; branch history excludes abandoned entries | Provider message and summary usage | Active-branch compaction entries |

“Exact” means exact for the provider field or event that was persisted; it
does not mean that a provider necessarily persisted every event that occurred.
“Partial” means some sessions, calls, names, or source fields are unavailable.

## Query and UI surfaces

- **Sessions**: provider, repository, project, tool, MCP server, MCP tool,
  skill, and compacted facets. Search also recognizes sessions with token/cache
  or compaction data.
- **Insights → Usage**: ranked ordinary tools, MCP servers, named MCP tools,
  and skills; each entry opens the matching Sessions filter.
- **Insights → Coverage**: provider-by-provider index, invocation, MCP-name,
  token, cache, and compaction coverage.
- **Session details / replay Stats**: source provenance, token components,
  derived uncached/miss tokens, cache-read share, compaction count, and quality
  notes.
- **CLI**: `vibe-replay sessions --compacted` and query output include recorded
  compaction evidence. Use `--scan` or `--brief` for scan-backed efficiency
  details.

The usage rollup intentionally contains only counters and timestamps. Full
inputs, results, prompts, and retained event details remain behind the
session-specific source/replay endpoints.

## Regression requirements

Provider changes should add fixtures for:

- duplicate streamed tool updates;
- empty success results versus unresolved calls;
- error-only and orphan tool completions;
- MCP calls with server-only or tool-only attribution;
- repeated skill activation versus skill metadata;
- compaction records and summary-only sessions;
- token snapshots with cache reads, writes, resets, and missing model
  attribution.

Any new deferred path must set `usageIndexed: false`, retain discovery counts,
and appear in the Coverage report rather than silently being counted as
complete.
