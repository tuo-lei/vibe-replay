# Importing a dot conversation

The `dot` provider imports saved, user-visible conversation read responses. It is
an **import-only provider**: it does not connect to an account or discover native
dot session storage. No raw or native dot session schema has been verified.

This document describes the implementation in this checkout. It does not imply
that the feature is available in a published npm release.

## Run from this checkout

Save an authorized conversation read response as a local JSON file, then build
and run the CLI from the repository root:

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js --provider dot --session export.json --open
```

`-p dot` is the short form of `--provider dot`. The explicit provider selects the
dot importer for the JSON input. `--open` opens the generated replay locally.
Imports use the neutral title “dot conversation” to keep prompt contents out of
metadata titles; set `--title` explicitly if you want a custom title.
Importing a file does not require discovery to be configured.

Import one JSON file containing one saved conversation window at a time. The
parser rejects multiple file paths: this response has no native room or session
identity that would establish that separate windows belong together. Automatic
multi-file merging is not supported. Do not concatenate JSON objects or convert
them to JSONL.

## Supported input

Use the saved conversation read response directly. Its top-level fields are
`message`, `before`, `after`, and `partial`. Messages from the surrounding arrays
have the same shape as `message`. The selected `message` may be `null`, but the
file must contain at least one replayable text message to import successfully.

The following is an **explicitly synthetic example**, not a real conversation or
evidence of an underlying native session format:

```json
{
  "message": {
    "message_id": "synthetic-dot-assistant-1",
    "channel": "chatgpt",
    "author": "aeon",
    "content": {
      "text": "The draft is ready to review.",
      "library_attachments": []
    },
    "sent_at": "2026-10-01T12:00:10Z",
    "deleted_at": null,
    "reply_to_id": null,
    "reply_root_message_id": null
  },
  "before": [
    {
      "message_id": "synthetic-dot-user-1",
      "channel": "chatgpt",
      "author": "user",
      "content": {
        "text": "Please help me prepare a draft.",
        "library_attachments": []
      },
      "sent_at": "2026-10-01T12:00:00Z",
      "deleted_at": null,
      "reply_to_id": null,
      "reply_root_message_id": null
    }
  ],
  "after": [],
  "partial": false
}
```

Supported channel values are `chatgpt` and `slack`. The visible author values are
`user` and `aeon`; `aeon` becomes assistant text in the replay. This import uses
`content.text`, rather than an invented `messages`, `events`, or raw-log schema.

The importer:

- Reads the supplied messages in `before`, `message`, then `after` order.
- Deduplicates messages by `message_id` within that file. Later duplicates
  supply updated content, but a deletion tombstone always wins. The position
  remains that of the first occurrence.
- Preserves the supplied room order rather than sorting by timestamps.
- Includes only supported, user-visible user and assistant text.
- Excludes deleted messages, internal records, and unsupported author roles.
- Uses only supplied message timestamps; it does not fabricate event times or
  recover execution timing from file modification dates.
- Flags input marked `partial: true` as incomplete.

`partial: false` does not establish that a saved response contains an entire
conversation. A read response can represent a selected window of visible
messages. The replay can only contain the messages actually supplied.

The generated identity is `dot-` followed by the first 20 hexadecimal characters
of a SHA-256 hash of message IDs, room order, deletion state, visible content,
timestamps, and partial status. It identifies a supplied snapshot, not a native
dot session. Corrections and deletions produce distinct snapshots rather than
silently competing with an older file during provider deduplication.
If a file changes after discovery, generation rejects stale session metadata;
refresh the session list before generating the changed snapshot.

A room response can include messages and replies mirrored from Slack as well as
the current dot conversation. The importer preserves their supplied order; it
does not invent separate threads, reconstruct missing replies, or establish a
native room identity.

## Optional local discovery

Set `DOT_EXPORTS_DIR` to a directory of saved JSON responses if you want them
available through provider discovery. For example, in a POSIX shell:

```bash
DOT_EXPORTS_DIR=/path/to/dot-exports node packages/cli/dist/index.js --provider dot
```

Discovery considers `*.json` files directly inside that directory. It does not
recurse into subdirectories. If `DOT_EXPORTS_DIR` is unset, the dot provider does
not scan for exports or look for native session storage. Use `--session` for a
specific file without setting this variable.

Each valid file is a separate discovery entry. For discovery metadata only, a
file with no valid message timestamps uses its modification time. That fallback
does not add message timestamps or supply agent execution timing.

Keep only intended conversation exports in the configured directory. Do not
point discovery at private application storage or use raw internal records as a
substitute for the supported user-visible response.

## Fidelity and privacy limits

This is a replay of the supplied visible conversation, not a reconstruction of
the assistant's execution:

- Tool calls and results, hidden reasoning, internal instructions, and agent
  traces are not imported.
- Model identity, token counts, cost, compactions, and other execution metrics are
  unavailable from this source. Missing metrics are not evidence that no
  computation occurred.
- Attachment contents are not imported or fetched. A message containing only an
  attachment does not provide a text scene.
- Message timestamps are retained only as conversation start/end metadata in
  generated replays. They are omitted from scene timing so gaps between chat
  messages cannot appear as LLM wait or represented agent time. If no valid timestamp exists, the conversation start and end remain
  unavailable rather than being replaced by the import date.
- Reply metadata in the input does not supply missing parent messages or a full
  conversation history.

Review the generated replay before sharing it: ordinary visible message text can
still contain personal or confidential information. Import only material you are
authorized to read and share.

Tests and examples for this provider use synthetic fixtures. They validate this
bounded import contract; they do not establish compatibility with an unverified
native dot export or internal session format.
