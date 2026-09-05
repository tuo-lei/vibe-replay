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
**separate sessions** — do not attach them to a parent. Duplicate roots
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
- Assistant `text` is private scratch → `thinking` blocks (not the visible reply)
- `send_message` and successful `communicate_update` are user-visible replies /
  status pings (`input.text.content`, widgets, occasional `to: "dm"` /
  attachments). Promote visible text to an assistant `text` block; do **not**
  emit those as tool-call scenes. Ignore `to` / `attachments` when extracting
  text. A `failure` / `rejected` / `error` `communicate_update` stays a
  `CommunicateUpdate` tool scene with `_isError` so a failed ping is visible
- `role: "tool"` lines carry `tool_result` (not Claude's user-nested pattern).
  Pair to the preceding `tool_use` by `toolCallId` when present, else by order
  (prefer matching tool name; leave unenriched rather than attaching another
  tool's result)
- Few/no top-level timestamps; synthesize ISO times from `result.success.timestamp`
  when it is epoch ms. Tool durations use the assistant record timestamp (when
  present) as the initial baseline, then advance to each result so later tools
  in the same turn are not cumulative from the start of the record
- JSONL has no native thinking blobs; scratch text is the thinking stand-in

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
  `@mentions`), then one turn per `Speaker: message`
- Humans (`User`, or any name not in the bot participant list) stay `role:
  "user"` with `speaker` set — the viewer shows `You` for generic `User`/`You`/
  `Human`, otherwise the name
- Other bots are `role: "assistant"` with `speaker` set (Eng, GTM, …). Do **not**
  stuff them into User. The contract stays `user | assistant`; `speaker` is the
  label
- Drop procedural cues: `It's your turn…`, `The room is wrapping up…`,
  `The conversation is wrapping up…`, `Waiting for participants…`,
  `No new messages in the room…` (empty wakes are not prompts)
- Repeat wakes for the same room do **not** re-emit the header
- Title becomes `Group: <room title>` when any group payload is seen
- `@Vibe Replay Eng` stays in speaker text and is listed on the room header

### Cross-agent merge

Sibling JSONLs that share the same room title (wake `[Group chat:"…"]`, else
`group.json` / profile `groupTitle`) merge into one discovered session
(`sessionId` / `slug` = `group-<normalized-title>`, `filePaths` = all members).

Parse each agent independently (owner name from profile, else `It's your turn,
<name>`), then:

1. Assign clocks: untimestamped turns inherit from the next/previous
   `result.success.timestamp` in that file (wake lines sit just before the
   owner's reply)
2. Sort by timestamp, humans before assistants on a tie
3. Dedupe identical human messages and duplicate room headers
4. Drop injected peer wake text when that peer's JSONL is in the merge — the
   peer's own `send_message` / tools / scratch win, even when the wake
   paraphrase differs

Single-agent / DM sessions are unchanged. A lone group transcript still shows
peer bots as assistant-side speakers using injected wake text (no sibling to
prefer). `sand-subagent-*` never merges.

Fixtures: `test/fixtures/sample.jsonl` (DM), `dm-session.jsonl`,
`group-eng.jsonl`, `group-gtm.jsonl`, `subagent.jsonl`, `meta-wake.jsonl`.

Try with:

```bash
GROK_BOT_TRANSCRIPTS_DIR=/path/to/agent-transcripts npx vibe-replay -p grok-bot
```
