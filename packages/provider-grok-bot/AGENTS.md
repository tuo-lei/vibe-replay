# AGENTS.md — Grok Bot provider

Grok Bot (Cursor Sand / box agents) sessions live on the **cloud box**, not a
user Mac. This package discovers and parses those JSONL transcripts.

## Locations

Defaults (when no env override is set):

- `/home/box/agent-data/agent-transcripts`
- `/home/box/sand-data/agent-transcripts` (`agent-data` often symlinks here)
- `~/.grok-bot/agent-transcripts` (documented export path for copies off the box)

Env (Pi-style, replaces defaults): `GROK_BOT_TRANSCRIPTS_DIR` or
`VIBE_REPLAY_GROK_BOT_DIR`.

Layout: `<root>/<agentId>/<agentId>.jsonl`. `sand-subagent-<uuid>/` files are
**separate sessions in v1** — do not attach them to a parent. Duplicate roots
(symlink overlap) are collapsed via `realpath`.

Project/title: sibling `agents/<id>/profile.json` `name` (and `cwd` / `workspace`
when present). Missing profiles are fine. DM sessions prefer that profile name;
group sessions use `Group: <room>`.

Do **not** look under macOS Application Support. SSH remote allowlisting is
follow-up, not this package. Skip `store.db` / conversation-blobs / encryption.

## JSONL

One object per line: `{ role: "user"|"assistant"|"tool", message: { content: [...] } }`.

- Skip user text containing `[SAND_HIDDEN_PROMPT]`
- Strip leading `[t0u]` / `[t3u]` prefixes from user text
- Meta wakes (after `[tNu]` strip):
  - `[routine]` / `[agent]` → `subtype: "context-injection"` (empty bodies dropped)
  - `[inbound]` → remaining body is a normal user prompt
  - `[Answering your question tbs1: "…"]` → context-injection; trailing text after
    the wrapper is a follow-up prompt when present
  - A meta tag wrapping `[Group chat:` is peeled so the group splitter still runs
- Assistant `text` is private scratch — keep it
- `send_message` and `communicate_update` are user-visible replies / status
  pings (`input.text.content`, widgets, occasional `to: "dm"` / attachments).
  Promote visible text to an assistant `text` block; do **not** emit those as
  tool-call scenes. Ignore `to` / `attachments` when extracting text
- `role: "tool"` lines carry `tool_result` (not Claude's user-nested pattern).
  Pair to the preceding `tool_use` by `toolCallId` when present, else by order
  (prefer matching tool name; leave unenriched rather than attaching another
  tool's result)
- Few/no top-level timestamps; synthesize ISO times from `result.success.timestamp`
  when it is epoch ms. Tool durations are inferred from the previous known
  timestamp → this result (assistant records rarely have their own clock)
- No thinking blobs in v1

## Tools

Sand builtins map onto the viewer vocabulary in `tool-mapping.ts`: `read`→`Read`,
`shell`→`Bash`, `update_todos`→`TodoWrite`, `task`→`Agent`, `await`→`Await`,
`computer_use`→`ComputerUse`, `get_mcp_tools`→`GetMcpTools`, plus the usual
web/edit aliases. `mcp` keeps its raw name and normalizes `server` / `tool` /
`tool_name` so scan usage matches Pi's single-`mcp` bridge. Bare GitHub MCP
names (`pull_request_read`, `get_file_contents`) pass through unchanged.

## Group chat

Group turns arrive as ordinary `role:"user"` text starting with `[Group chat:`.
Do **not** treat the blob as one human prompt.

- Split into: one `subtype: "context-injection"` room header (title, participants,
  `@mentions`), then one user turn per `Speaker: message` in order (`**Speaker:**`
  prefix — the viewer has no multi-speaker scene type)
- Drop procedural cues: `It's your turn…`, `The room is wrapping up…`,
  `The conversation is wrapping up…`, `Waiting for participants…`,
  `No new messages in the room…` (empty wakes are not prompts)
- Repeat wakes for the same room do **not** re-emit the header
- Title becomes `Group: <room title>` when any group payload is seen
- Discovery: project = group title from recent wakes, else sibling
  `agents/<id>/group.json` / profile `groupTitle`. Eng and GTM stay separate
  transcripts in v1 — no cross-agent timeline merge
- `@Vibe Replay Eng` stays in speaker text and is listed on the room header

Fixtures: `test/fixtures/sample.jsonl` (DM), `dm-session.jsonl`,
`group-eng.jsonl`, `group-gtm.jsonl`, `subagent.jsonl`, `meta-wake.jsonl`.

Try with:

```bash
GROK_BOT_TRANSCRIPTS_DIR=/path/to/agent-transcripts npx vibe-replay -p grok-bot
```
