# AGENTS.md — Muse provider

Muse agent transcripts live under the agents root (env `MUSE_AGENTS_DIR`,
default `~/agents`):

```
<agentsRoot>/<agentId>/sessions/<agentId>.jsonl   # transcript (one JSON object per line)
<agentsRoot>/<agentId>/sessions/sessions.json     # runtime index (best-effort only)
```

## Record layout

- `{"type":"session_header", "session_id", "agent_id", "created_at"}` — once per file
- `{"type":"item", "seq", "source", "item":{...}, "created_at"}` — transcript items
- `{"type":"compaction_checkpoint", "compaction_id", "trigger", "summary"}` —
  context compactions. The `summary` is a full pre-compaction conversation
  summary and is intentionally **not** replayed (too large); it only feeds
  `compactions[]` metadata.

## Item kinds

- `message` (`role: user|assistant|developer`) — plain `text`
- `message_parts` (`role`, `parts[]`) — text lives in `parts[].text`
- `thinking` — `thinking` field → assistant thinking block
- `commentary_text` — short assistant narration → assistant text block
- `function_call` (`call_id`, `name`, `arguments` as a JSON string) → tool_use
- `function_call_output` (`call_id`, `output`, `success`) — matched to the call
  by `call_id`; `success: false` marks the block as an error

Decisions:

- `developer` messages are skipped — they are runtime/system instructions, not
  user content, and the replay is meant to be shareable.
- Every item record carries a `source` provenance label (`runtime`,
  `runtime.feed`, `runtime.self_improvement`, `scheduler.cron`,
  `runtime.monitoring`, ...). A bare `runtime` source means interactive: real
  user turns and subagent delegations. Dotted `runtime.*` / `scheduler.cron`
  sources are runtime directives (feed jobs, self-improvement runs, cron
  workers), not user prompts — discovery skips them for `firstPrompt`/title
  while still counting them in `promptCount`.
- Discovery skips `[Subagent Context]`-prefixed user messages for
  `firstPrompt`/title (huge injected boilerplate on delegated sessions) but
  still counts them. Sessions whose only user message is such an injection
  stay discoverable as long as they have prompts or tool calls.
- Built-in tool names/args are normalized to canonical form (`exec`→`Bash`,
  `edit`→`Edit` with `path`/`old_text`/`new_text` mapped to
  `file_path`/`old_string`/`new_string`, `write`→`Write`, `read`→`Read`) so
  replays render terminal output/diffs and edit analytics count them.
  Namespaced agent tools (`memory_search`, `subagent.spawn`, ...) pass through.
- Token usage is not reported: the format has no per-message usage, and
  `sessions.json` `context_window_usage` is a point-in-time snapshot, not a
  session total. `model` comes from that snapshot's `model_id`.
- Non-object JSON lines (`null`, arrays) and a non-object `sessions.json`
  are tolerated: the line is skipped with a parse warning (or ignored in
  discovery), never fatal.

## Notes

- Transcripts may contain thinking, tool arguments, and tool output — treat
  generated replays as potentially sensitive, like any other provider.
- Unknown record/item types are skipped silently (forward compatibility);
  only malformed JSON lines produce parse warnings.
