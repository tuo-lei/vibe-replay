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

Layout: `<root>/<agentId>/<agentId>.jsonl`. `sand-subagent-<uuid>/` files stay
in discovery as their own sessions. A parent `task` call attaches a child-run
card when the result/input names that sibling id (no nested grandchildren).
Duplicate roots (symlink overlap) are collapsed via `realpath`.

Project/title: sibling `agents/<id>/profile.json` `name` (and `cwd` / `workspace`
when present). Missing profiles are fine. DM sessions prefer that profile name;
group sessions use `Group: <room>`.

Do **not** look under macOS Application Support. SSH remote allowlisting is
follow-up, not this package. Skip `store.db` / conversation-blobs / encryption.

## JSONL

One object per line: `{ role: "user"|"assistant"|"tool", message: { content: [...] } }`.

- Skip user text containing `[SAND_HIDDEN_PROMPT]` or a lone `[first run]`
- Strip leading `[t0u]` / `[t3u]` prefixes from user text
- Meta wakes (after `[tNu]` strip):
  - `[routine]` / `[agent]` → `subtype: "context-injection"` (empty bodies dropped)
  - `[inbound]` → remaining body is a normal user prompt
  - `[Answering your question tbs1: "…"]` → context-injection; trailing text after
    the wrapper is a follow-up prompt when present
  - `[A background task just completed]` → context-injection (not a user prompt /
    Explore firstPrompt)
  - `<<SAND_AGENT_PROFILE_UPDATE…>>` → skipped (or stripped if other text remains)
  - A meta tag wrapping `[Group chat:` is peeled so the group splitter still runs
- Assistant `text` is private scratch → `thinking` blocks (not the visible reply)
- `send_message` is the user-visible reply (`input.text.content` dict or string,
  widgets). Promote visible text to an assistant `text` block; do **not** emit
  it as a tool-call scene. Ignore `to` / `attachments` when extracting text.
  `file://` / data-URL markdown images in that text become a path mention —
  they are not inlined into shareable HTML
- `communicate_update` is a high-volume status/memory side-effect. Keep it as a
  `CommunicateUpdate` tool scene (including success). Do **not** promote it to
  an assistant reply. `_isError` still marks `failure` / `rejected` / `error`
- `role: "tool"` lines carry `tool_result` (not Claude's user-nested pattern).
  Pair to the preceding `tool_use` by `toolCallId` when present, else by order
  (prefer matching tool name; leave unenriched rather than attaching another
  tool's result)
- `generate_image` / `computer_use` results keep `filePath` / `screenshotPath`
  and replace embedded `imageData` / screenshot base64 with an `[omitted …]`
  stub so a 16MB artist JSONL stays parseable
- Few/no top-level timestamps; synthesize ISO times from `result.success.timestamp`
  when it is epoch ms. Tool durations use the assistant record timestamp (when
  present) as the initial baseline, then advance to each result so later tools
  in the same turn are not cumulative from the start of the record
- JSONL has no native thinking blobs; scratch text is the thinking stand-in

## Tools

Sand builtins map onto the viewer vocabulary in `tool-mapping.ts`: `read`→`Read`,
`shell`→`Bash`, `update_todos`→`TodoWrite`, `task`→`Agent`, `await`→`Await`,
`computer_use`→`ComputerUse`, `generate_image`→`GenerateImage`, plus the usual
web/edit aliases. `get_mcp_tools` is discovery noise and is omitted from scenes.
`mcp` keeps its raw name and normalizes `server` / `tool` / `tool_name`. Dynamic
MCP calls use short names (`pull_request_read`, `search_analytics_query`) plus
`serverIdentifier` / `providerIdentifier` / `toolName` / `args` and become
`mcp__<server>__<tool>` cards with `_mcpServer` / `_mcpTool`.

## Group chat

Group turns arrive as ordinary `role:"user"` text starting with `[Group chat:`.
Do **not** treat the blob as one human prompt.

- Split into: one `subtype: "context-injection"` room header (title, participants,
  `@mentions`), then one turn per `Speaker: message`
- Humans (`User`, or any name not in the bot participant list) stay `role:
  "user"` with `speaker` set — the viewer shows `You` for generic `User`/`You`/
  `Human`, otherwise the name
- Other bots are `role: "assistant"` with `speaker` set (Eng, GTM, 艺术家, …).
  Display names (including emoji/CJK) are labels; merge/dedupe keys strip
  punctuation/emoji so `🧭旅游助手` matches `旅游助手`
- Drop procedural cues: `It's your turn…`, `The room is wrapping up…`,
  `The conversation is wrapping up…`, `Waiting for participants…`,
  `No new messages in the room…` (empty wakes are not prompts)
- Repeat wakes for the same room do **not** re-emit the header
- Title becomes `Group: <room title>` when any group payload is seen
- `@Vibe Replay Eng` stays in speaker text and is listed on the room header
- Room slug `normalizeGroupKey` keeps Unicode letters/numbers so CJK titles
  do not all collapse to `group`

### Cross-agent merge

Sibling JSONLs that share the same room title (wake `[Group chat:"…"]`, else
`group.json` / profile `groupTitle`) merge into one discovered session
(`sessionId` / `slug` = `group-<normalized-title>`, `filePaths` = all members).
Member identity is the agent UUID (directory name); display names are labels.

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
prefer). `sand-subagent-*` never merges into a group room.

Fixtures: `test/fixtures/sample.jsonl` (DM), `dm-session.jsonl`,
`group-eng.jsonl`, `group-gtm.jsonl`, `subagent.jsonl`, `meta-wake.jsonl`.

Try with:

```bash
GROK_BOT_TRANSCRIPTS_DIR=/path/to/agent-transcripts npx vibe-replay -p grok-bot
```
