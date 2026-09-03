# Ask Replay feature parity

Ask Replay is the local, read-only chat surface. It is not an unrestricted agent:
it may inspect Vibe Replay data and navigate the editor, but it must not change
files, replay data, credentials, settings, or publishing state without a
separate, explicitly designed confirmation flow.

## Current parity

| UI capability | Ask Replay support | Tool / limitation |
| --- | --- | --- |
| Sessions and Replays explorer search | **Supported** | `search_sessions` mirrors text, project, provider, repository, branch, model, tool, MCP server/tool, skill, compaction, archive, replay availability, date, and sort filters. |
| Session source metadata | **Supported** | Search results expose replay availability, transcript/data quality, files, tools, git identity, model, and compact stats. |
| Replay summary / Stats panel | **Supported** | `get_session_summary` includes token/cache metrics, context composition, turns, diagnostics, PRs, branches, data source, sub-agents, and editor metadata. |
| Replay scene search and inspection | **Supported** | `get_session_content` is bounded and `get_scene` includes tool inputs/results, durations, commands, diffs, and scene annotations. |
| Replay comments / AI Coach feedback | **Supported (read-only)** | `get_session_annotations` returns selected text, author, resolved state, and scene navigation. |
| Translation / tone overlays | **Supported (read-only)** | `get_session_overlays` and effective scene reads distinguish original from currently displayed content. |
| Personal Insights | **Supported** | `get_insights` supports `7d`, `30d`, `90d`, `all`, or custom bounds, including activity, workspace, tokens, costs, distributions, Tools/MCP/skills, and coverage. |
| Project Overview / Hot Files / branches | **Supported** | `get_insights` with `scope=project` exposes project totals, activity, hot files, branches/PRs, models, timing, tokens, and usage. |
| Dashboard navigation | **Supported** | `open_dashboard` can open tabs, Settings, projects, ranges, and explorer facets. `open_replay` can open replay, Summary, or Export. |
| Resource permalinks | **Supported** | Sessions, scenes, source-session popups, projects, Insights ranges, Settings sections, and mutation handoffs return same-origin deep links. |
| Mutation / publish handoff | **Supported (user-click only)** | `prepare_user_action` returns a permalink and UI action for review. It never executes the mutation. |
| Scan/cache/usage completeness | **Supported** | `get_data_status` explains stale catalogs, scan progress, failed providers, usage backfill, and pending indexes. |
| Generate/regenerate/delete/archive a replay | **Read-only by design** | Chat can find and open the relevant session, but cannot mutate local state. |
| Rename, save comments, translation, tone, AI Coach | **Read-only by design** | The UI can perform these actions; chat currently reports/opens their results but cannot perform them. |
| Gist/cloud/GitHub export or publish | **Read-only by design** | Use the Export view so authentication and confirmation remain visible. |
| Live mode | **Not exposed** | SSH live mode is unavailable; local live navigation can be added as a separate safe action. |

## Does a new UI feature automatically enhance chat?

No. A UI feature does not automatically become an assistant capability. The
assistant runs server-side tools with bounded payloads and a separate privacy
boundary, so every new inspectable feature needs an explicit tool/data mapping.

When adding a user-visible feature, use this checklist:

1. Add the durable/read-only field to the server data source or shared type.
2. Decide whether the assistant should **explain**, **navigate**, or **mutate** it.
3. For explain/navigation capabilities, extend an existing tool or add a new
   bounded tool in `packages/cli/src/local-assistant.ts`.
4. Give the resource a stable same-origin permalink. Prefer query parameters
   that identify the resource, view, and nested section rather than an
   ephemeral browser event.
5. For mutations, return `prepare_user_action`-style handoff data instead of
   calling the mutating endpoint from the assistant.
6. Add the corresponding UI label and action validation in
   `packages/viewer/src/components/LocalChatAssistant.tsx`.
7. Preserve SSH consent and credential-shaped redaction; never send raw tool
   inputs/results or provider secrets to the model unnecessarily.
8. Add a tool contract test in `packages/cli/test/local-assistant.test.ts` and
   update this matrix.

Mutating capabilities should not be added by simply exposing an existing UI
endpoint. They need an explicit confirmation, audit, cancellation, and remote
data policy first.
