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
when present). Missing profiles are fine.

Do **not** look under macOS Application Support. SSH remote allowlisting is
follow-up, not this package. Skip `store.db` / conversation-blobs / encryption.

## JSONL

One object per line: `{ role: "user"|"assistant"|"tool", message: { content: [...] } }`.

- Skip user text containing `[SAND_HIDDEN_PROMPT]`
- Strip leading `[t0u]` / `[t3u]` prefixes from user text
- Assistant `text` is private scratch — keep it
- `send_message` is the user-visible reply (`input.text.content` string, sometimes
  widgets). Promote that string to an assistant `text` block; do **not** emit
  `send_message` as a tool-call scene
- `role: "tool"` lines carry `tool_result` (not Claude's user-nested pattern).
  Pair to the preceding `tool_use` by `toolCallId` when present, else by order
  (prefer matching tool name; leave unenriched rather than attaching another
  tool's result)
- Few/no top-level timestamps; synthesize ISO times from `result.success.timestamp`
  when it is epoch ms, otherwise omit / use file mtime for discovery
- No thinking blobs in v1

## Group chat

Group turns arrive as ordinary `role:"user"` text starting with `[Group chat:`.
Do **not** treat the blob as one human prompt.

- Split into: one `subtype: "context-injection"` room header (title, participants,
  `@mentions`), then one user turn per `Speaker: message` in order (`**Speaker:**`
  prefix — the viewer has no multi-speaker scene type)
- Drop procedural cues: `It's your turn…`, `The room is wrapping up…`,
  `No new messages in the room…` (empty wakes are not prompts)
- Title becomes `Group: <room title>` when any group payload is seen
- Discovery: project = group title from recent wakes, else sibling
  `agents/<id>/group.json` / profile `groupTitle`. Eng and GTM stay separate
  transcripts in v1 — no cross-agent timeline merge
- `@Vibe Replay Eng` stays in speaker text and is listed on the room header

Fixtures: `test/fixtures/group-eng.jsonl`, `test/fixtures/group-gtm.jsonl`.

Try with:

```bash
GROK_BOT_TRANSCRIPTS_DIR=/path/to/agent-transcripts npx vibe-replay -p grok-bot
```
