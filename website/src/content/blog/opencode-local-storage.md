---
title: "What Does OpenCode Store on Your Machine? A Deep Dive into opencode.db"
excerpt: "OpenCode stores sessions, messages, and tool parts in SQLite instead of a folder of JSONL files. Here's the schema, the compaction trap, and how to read it safely."
date: 2026-08-03
readTime: "7 min read"
---

OpenCode looks like a chat interface, but its local history is closer to an application database.

That matters the first time you try to answer a simple question such as “show me the session where the agent changed the router.” There is no canonical transcript file to open. The answer is distributed across a session row, message rows, and part rows inside SQLite.

The useful mental model is:

```text
session row   → identity, title, project, timestamps, model, cost
message rows  → user/assistant boundaries and message metadata
part rows     → text, reasoning, tools, files, results, compaction markers
```

vibe-replay treats those rows as one logical conversation and turns them into the same replay vocabulary used for Claude Code, Cursor, Codex, Hermes, and Pi.

## Where does OpenCode store its database?

On macOS and Linux, OpenCode normally uses:

```text
~/.local/share/opencode/opencode.db
```

On Windows, the default follows `%LOCALAPPDATA%\opencode\opencode.db`. The `OPENCODE_DATA` environment variable overrides the data directory on every platform.

So the portable way to locate the database is:

```bash
echo "${OPENCODE_DATA:-$HOME/.local/share/opencode}/opencode.db"
```

The variable names and schema are implementation details of the local OpenCode build. A future release may add columns or reshape JSON payloads without changing the fact that the database is the source of truth.

If SQLite is installed, a quick inventory is:

```bash
sqlite3 "${OPENCODE_DATA:-$HOME/.local/share/opencode}/opencode.db" \
  '.tables'
```

The tables that matter for replay are usually `session`, `message`, and `part`. Some versions also carry project or auxiliary tables.

## Why are sessions, messages, and parts separate?

OpenCode has a relational conversation model. A session is the container; messages establish roles and timestamps; parts hold the content that makes a message interesting.

A simplified shape looks like this:

```text
session(id, slug, title, directory, time_created, time_updated, model, cost)
  └── message(id, session_id, data)
        └── part(id, message_id, data)
```

The `data` columns are JSON rather than a single normalized column for every possible event. That lets OpenCode add a new part type without a database migration for every UI feature, but it means a reader must validate JSON and branch on `type`.

Typical message metadata includes:

- `role`: user or assistant;
- created and completed timestamps;
- model id;
- token usage and cache fields;
- finish reason.

Typical parts include:

- user text;
- assistant text;
- reasoning;
- tool calls and their state;
- patches or file changes;
- images and files;
- compaction markers.

The part boundary is important. A message with a tool call is not the same thing as a message whose text merely mentions a tool. Counting parts gives you tool-call volume; counting user message text gives you prompts.

## The compaction trap: not every user-looking row is a prompt

OpenCode writes context compaction as a synthetic user message with a compaction part. That row may also contain text.

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

- session cost is a provider-reported total when present;
- message usage is attached to an assistant response;
- a missing value means “not recorded,” not “zero.”

vibe-replay preserves provider-reported cost when it exists and keeps token categories separate. It does not silently add a session total to per-message totals, which would double count the bill.

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

Discovery reads the `session` table and joins aggregate counts from `message` and `part`. Each discovered session gets a marker path in this form:

```text
<database-path>#session:<session-id>
```

That is not a file that OpenCode creates. It is a replay-tool pointer that preserves which database and which session should be parsed later.

When you open a replay, the provider:

1. resolves the session id from the marker;
2. opens the hinted SQLite database with a portable read-only reader;
3. reads messages in timestamp order;
4. expands parts into text, reasoning, tool calls, results, images, and compaction events;
5. maps provider-specific tool names into the shared viewer vocabulary;
6. records parse warnings instead of hiding malformed rows.

That gives OpenCode sessions the same useful output as a JSONL provider without pretending the underlying storage is JSONL.

## A safe way to inspect OpenCode history

Start with metadata, not a full dump:

```bash
DB="${OPENCODE_DATA:-$HOME/.local/share/opencode}/opencode.db"
sqlite3 "$DB" \
  'select id, title, directory, datetime(time_updated/1000, "unixepoch")
   from session order by time_updated desc limit 10;'
```

Do not paste the result into a public issue without checking it. Titles, directories, prompts, tool arguments, and file contents can all be sensitive. Generate a reviewed replay instead of sharing the database.

If Claude Code’s one-file JSONL model is the simple case, OpenCode is the database case: structured, queryable, and more version-sensitive. Once you follow the session → message → part chain, the storage stops looking mysterious — and the replay can preserve the details that a flat session list leaves out.
