---
title: "What Does OpenCode Store Locally? opencode.db Explained"
excerpt: "OpenCode stores sessions, messages, and tool parts in SQLite—not JSONL. Here's the schema, the subagent rows, the compaction trap, and how to read it safely."
cover: "/blog/opencode-storage/storage-map.png"
date: 2026-08-03
updated: 2026-09-03
readTime: "8 min read"
---

OpenCode looks like a chat interface, but its local history is closer to an application database.

That matters the first time you try to answer a simple question such as “show me the session where the agent changed the router.” There is no canonical transcript file to open. The answer is distributed across a session row, message rows, and part rows inside SQLite.

The useful mental model is:

```text
session row   → identity, title, project, parent_id, timestamps, model JSON, cost
message rows  → user/assistant boundaries and message metadata
part rows     → text, reasoning, tools, step markers, files, compaction
```

![Diagram of the OpenCode opencode.db session, message, and part tables](/blog/opencode-storage/storage-map.png)

vibe-replay treats those rows as one logical conversation and turns them into the same replay vocabulary used for Claude Code, Cursor, Codex, Hermes, and Pi.

## Where does OpenCode store its database?

On macOS and Linux, OpenCode normally uses:

```text
~/.local/share/opencode/opencode.db
```

On Windows, the default follows `%LOCALAPPDATA%\opencode\opencode.db`. `OPENCODE_DATA` overrides the data directory on every platform. On macOS and Linux, `XDG_DATA_HOME` can move the whole XDG data root, so the default is `${XDG_DATA_HOME:-$HOME/.local/share}/opencode`.

The portable way to locate the database on macOS and Linux is:

```bash
echo "${OPENCODE_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode}/opencode.db"
```

On Windows, use `%OPENCODE_DATA%\opencode.db` when that variable is set, otherwise `%LOCALAPPDATA%\opencode\opencode.db`. The Bash snippets below are for Unix shells.

The variable names and schema are implementation details of the local OpenCode build. A future release may add columns or reshape JSON payloads without changing the fact that the database is the source of truth.

If SQLite is installed, a quick inventory is:

```bash
sqlite3 "${OPENCODE_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode}/opencode.db" \
  '.tables'
```

The tables that matter for replay are usually `session`, `message`, and `part`. Some versions also carry project or auxiliary tables.

## Why are sessions, messages, and parts separate?

OpenCode has a relational conversation model. A session is the container; messages establish roles and timestamps; parts hold the content that makes a message interesting.

A simplified shape looks like this:

```text
session(id, parent_id, slug, title, directory, time_created, time_updated, model, cost)
  └── message(id, session_id, data)
        └── part(id, message_id, session_id, data)
```

The `data` columns are JSON rather than a single normalized column for every possible event. That lets OpenCode add a new part type without a database migration for every UI feature, but it means a reader must validate JSON and branch on `type`.

`model` is not a plain string. Current builds store JSON such as `{"id":"…","providerID":"opencode"}`. Selecting the column as if it were the model name will print the whole object.

Typical message metadata includes:

- `role`: user or assistant;
- created and completed timestamps;
- model id;
- token usage and cache fields;
- finish reason.

Typical parts include:

- `text` and `reasoning`;
- `tool` calls and their state;
- `patch` and `file`;
- `compaction` markers;
- `step-start` / `step-finish` streaming markers.

Those last two are usually the most numerous part types. They are not prompts, tools, or results. Counting every part as content inflates activity; counting only `tool` parts gives tool-call volume, and counting user `text` parts (minus compaction) gives prompts.

## Child sessions are not top-level conversations

OpenCode stores subagent work as extra `session` rows with `parent_id` set. The titles look like conversations — `Explore repo structure (@explore subagent)` — but they belong to a parent session, not the picker.

A catalog query that does `SELECT * FROM session` therefore lists children next to their parents. vibe-replay keeps those child rows out of discovery when the column exists:

```sql
SELECT id, slug, title, directory
FROM session
WHERE parent_id IS NULL;
```

Older databases may not have `parent_id`. In that case the filter has to disappear rather than fail with `no such column`. The child row is still parseable if you already have its id; it just should not appear as its own card in a session list.

## The compaction trap: not every user-looking row is a prompt

OpenCode writes context compaction as a synthetic user message with a `compaction` part. Current builds often store that part alone. Older or mixed messages can also carry `text` on the same row.

If you count every `role = 'user'` message, the compaction summary becomes an extra human prompt. The dashboard then reports too many turns, and the first-prompt preview can become a summary instead of something the user typed.

The safe query shape is closer to:

```sql
SELECT m.session_id, COUNT(DISTINCT m.id)
FROM part p
JOIN message m ON m.id = p.message_id
WHERE json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.type') = 'text'
  AND NOT EXISTS (
    SELECT 1
    FROM part compact
    WHERE compact.message_id = m.id
      AND json_extract(compact.data, '$.type') = 'compaction'
  )
GROUP BY m.session_id;
```

Real databases need an additional guard around malformed JSON. `json_valid(data)` keeps a damaged or partially-written row from taking down the whole discovery pass.

Compaction is not lost just because it is excluded from prompt counts. vibe-replay keeps it as a distinct replay event so you can see where context was summarized and how the conversation continued.

## Why schema drift is normal here

OpenCode has changed the `session` table over time. Fields such as `agent`, `model`, `cost`, and token columns may be absent in an older database or named differently in a newer one.

A brittle reader does this:

```sql
SELECT id, title, agent, model, cost, tokens_input
FROM session;
```

That query is fine until one optional column is missing. A resilient reader first asks SQLite what exists:

```sql
PRAGMA table_info(session);
```

Then it builds a projection from the columns that are actually present. Missing model or cost metadata should lower the quality of one metric, not make every session disappear.

This is a general lesson for local AI-agent storage: the database is real, but it is not necessarily a stable public API. Version-tolerant discovery is part of replay correctness.

## Where do costs and tokens come from?

Some OpenCode versions persist session-level cost and token fields. Assistant message JSON can also contain per-message usage, including cached input and output. Those values have different scopes:

- `session.cost` is a provider-reported total, but the column is often `NOT NULL` with a stored `0.0`;
- free or unbilled models commonly keep that zero even after millions of input tokens;
- message usage is attached to an assistant response;
- a stored zero is closer to “not billed / not recorded” than to a reconstructed $0.00 invoice.

vibe-replay preserves provider-reported cost only when it is positive, and it keeps token categories separate. It does not treat `cost = 0` as a bill, and it does not add a session total to per-message totals.

The same principle applies to timing. OpenCode has message timestamps, but idle gaps are not necessarily active model time. A replay can show the timeline while labeling reconstructed duration as an estimate.

## The WAL problem: why a live session may be invisible

SQLite can write recent changes to a write-ahead log next to the main database:

```text
opencode.db
opencode.db-wal
opencode.db-shm
```

If a process has not checkpointed those frames into `opencode.db`, a reader that opens only the main file may not see the newest session. This is particularly relevant while OpenCode is running for a long time.

A tool should not copy or mutate the live database just to chase those rows. It should report the limitation, retry when the database is checkpointed, or use a provider-supported read path. vibe-replay keeps SQLite reads read-only and uses a lightweight discovery path for database-backed sessions so a large database is not opened once per dashboard card.

## How vibe-replay reads OpenCode

Discovery reads the `session` table, skips child rows when `parent_id` is present, and joins aggregate counts from `message` and `part`. Each discovered session gets a marker path in this form:

```text
<database-path>#session:<session-id>
```

That is not a file that OpenCode creates. It is a replay-tool pointer that preserves which database and which session should be parsed later.

When you open a replay, the provider:

1. resolves the session id from the marker;
2. opens the hinted SQLite database with a portable read-only reader;
3. reads messages in timestamp order;
4. expands parts into text, reasoning, tool calls, results, images, and compaction events, skipping `step-start` / `step-finish`;
5. maps provider-specific tool names into the shared viewer vocabulary;
6. records parse warnings instead of hiding malformed rows.

That gives OpenCode sessions the same useful output as a JSONL provider without pretending the underlying storage is JSONL.

## A safe way to inspect OpenCode history

Start with metadata, not a full dump:

```bash
DB="${OPENCODE_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode}/opencode.db"
sqlite3 "$DB" \
  'select id, title, directory, parent_id,
          datetime(time_updated/1000, "unixepoch")
   from session
   where parent_id is null
   order by time_updated desc limit 10;'
```

If `parent_id` is missing, drop that column and the `where` clause. That is the schema-drift case above, not a broken install.

Do not paste the result into a public issue without checking it. Titles, directories, prompts, tool arguments, and file contents can all be sensitive. Generate a reviewed replay instead of sharing the database.

If Claude Code’s one-file JSONL model is the simple case, OpenCode is the database case: structured, queryable, and more version-sensitive. Once you follow the session → message → part chain, the storage stops looking mysterious — and the replay can preserve the details that a flat session list leaves out.

For the same storage question in other providers, compare the profile-aware [Hermes `state.db`](/blog/hermes-local-storage/) and the branch-aware [Pi session JSONL](/blog/pi-local-storage/) layouts.
