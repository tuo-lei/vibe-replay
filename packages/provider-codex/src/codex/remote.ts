import type { CodexSessionMetadata } from "./discover.js";

export interface RemoteCodexMetadataResult {
  entries: Map<string, CodexSessionMetadata>;
  available: boolean;
}

/**
 * Query only the small, read-only metadata surface that Codex uses for
 * `/resume`. The rollout JSONL remains the source for replay contents.
 */
export const CODEX_REMOTE_METADATA_SCRIPT = `# VIBE_REPLAY_CODEX_METADATA
home=\${HOME:-}
if [ -z "$home" ]; then
  home=$(pwd)
fi
codex_home=\${CODEX_HOME:-"$home/.codex"}
sqlite_home=\${CODEX_SQLITE_HOME:-"$codex_home"}
db="$sqlite_home/state_5.sqlite"
[ -f "$db" ] || exit 0

python_bin=
if command -v python3 >/dev/null 2>&1; then
  python_bin=python3
elif command -v python >/dev/null 2>&1; then
  python_bin=python
fi

if [ -n "$python_bin" ]; then
  if VIBE_REPLAY_CODEX_DB="$db" "$python_bin" - <<'PY'
import json
import os
import sqlite3
import sys
from urllib.parse import quote

db_path = os.environ["VIBE_REPLAY_CODEX_DB"]

def main():
    try:
        db = sqlite3.connect(
            "file:" + quote(db_path, safe="/") + "?mode=ro",
            uri=True,
            timeout=2,
        )
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
        if "id" not in columns:
            return 1

        names = [
            "id",
            "rollout_path",
            "created_at",
            "updated_at",
            "created_at_ms",
            "updated_at_ms",
            "cwd",
            "title",
            "git_branch",
            "cli_version",
            "first_user_message",
            "model",
        ]
        select = [
            name if name in columns else "NULL AS " + name
            for name in names
        ]
        where = " WHERE archived = 0" if "archived" in columns else ""
        order_names = [
            name
            for name in ("updated_at_ms", "updated_at")
            if name in columns
        ]
        order = (
            " ORDER BY " + ", ".join(name + " DESC" for name in order_names)
            if order_names
            else ""
        )
        rows = db.execute(
            "SELECT " + ", ".join(select) + " FROM threads" + where + order
        )
        records = []
        for row in rows:
            record = {"type":"thread"}
            mapping = {
                "sessionId": "id",
                "rolloutPath": "rollout_path",
                "createdAt": "created_at",
                "updatedAt": "updated_at",
                "createdAtMs": "created_at_ms",
                "updatedAtMs": "updated_at_ms",
                "cwd": "cwd",
                "title": "title",
                "gitBranch": "git_branch",
                "cliVersion": "cli_version",
                "firstUserMessage": "first_user_message",
                "model": "model",
            }
            for output_name, column_name in mapping.items():
                value = row[column_name]
                if value is not None and value != "":
                    record[output_name] = value
            records.append(record)
        print(json.dumps({"type":"status","available":True}, separators=(",",":")))
        for record in records:
            print(json.dumps(record, ensure_ascii=True, separators=(",", ":")))
        db.close()
        return 0
    except Exception:
        return 1

sys.exit(main())
PY
  then
    exit 0
  fi
fi

if command -v sqlite3 >/dev/null 2>&1; then
  has_column() {
    [ "$(sqlite3 -readonly -noheader "$db" "SELECT COUNT(*) FROM pragma_table_info('threads') WHERE name = '$1';" 2>/dev/null)" = "1" ]
  }
  column_expr() {
    if has_column "$1"; then
      printf '%s' "$1"
    else
      printf 'NULL AS %s' "$1"
    fi
  }
  select_list=
  for column in id rollout_path created_at updated_at created_at_ms updated_at_ms cwd title git_branch cli_version first_user_message model; do
    expression=$(column_expr "$column") || exit 0
    if [ -n "$select_list" ]; then
      select_list="$select_list, $expression"
    else
      select_list="$expression"
    fi
  done
  has_column id || exit 0
  where_clause=
  if has_column archived; then
    where_clause=" WHERE archived = 0"
  fi
  order_clause=
  if has_column updated_at_ms || has_column updated_at; then
    order_list=
    if has_column updated_at_ms; then
      order_list="updated_at_ms DESC"
    fi
    if has_column updated_at; then
      if [ -n "$order_list" ]; then
        order_list="$order_list, updated_at DESC"
      else
        order_list="updated_at DESC"
      fi
    fi
    order_clause=" ORDER BY $order_list"
  fi
  rows=$(sqlite3 -readonly -json "$db" "SELECT $select_list FROM threads$where_clause$order_clause;" 2>/dev/null) || exit 0
  printf '{"type":"status","available":true}\\n'
  printf '%s\\n' "$rows"
fi
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function remoteRecordValue(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

function remoteMetadataFromRecord(value: unknown): CodexSessionMetadata | null {
  if (!isRecord(value)) return null;
  const sessionId = nonEmptyString(remoteRecordValue(value, "sessionId", "id"));
  if (!sessionId) return null;

  const metadata: CodexSessionMetadata = { sessionId };
  const stringFields = [
    ["rolloutPath", "rollout_path"],
    ["cwd", "cwd"],
    ["title", "title"],
    ["gitBranch", "git_branch"],
    ["cliVersion", "cli_version"],
    ["firstUserMessage", "first_user_message"],
    ["model", "model"],
  ] as const;
  for (const [field, ...aliases] of stringFields) {
    const fieldValue = nonEmptyString(remoteRecordValue(value, field, ...aliases));
    if (fieldValue) metadata[field] = fieldValue;
  }

  for (const [field, ...aliases] of [
    ["createdAt", "created_at"],
    ["updatedAt", "updated_at"],
  ] as const) {
    const fieldValue = remoteRecordValue(value, field, ...aliases);
    if (
      (typeof fieldValue === "string" && fieldValue.trim()) ||
      (typeof fieldValue === "number" && Number.isFinite(fieldValue))
    ) {
      metadata[field] = fieldValue;
    }
  }
  for (const [field, ...aliases] of [
    ["createdAtMs", "created_at_ms"],
    ["updatedAtMs", "updated_at_ms"],
  ] as const) {
    const fieldValue = remoteRecordValue(value, field, ...aliases);
    if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
      metadata[field] = fieldValue;
    }
  }
  return metadata;
}

/** Parse the provider-neutral JSON/JSONL response emitted by the remote query. */
export function parseCodexRemoteMetadata(output: Uint8Array): RemoteCodexMetadataResult {
  const text = new TextDecoder().decode(output).trim();
  if (!text) return { entries: new Map(), available: false };

  const records: unknown[] = [];
  const appendRecords = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) appendRecords(item);
    } else {
      records.push(value);
    }
  };
  try {
    const parsed: unknown = JSON.parse(text);
    appendRecords(parsed);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        appendRecords(JSON.parse(line));
      } catch {
        // Ignore malformed records and retain the JSONL fallback.
      }
    }
  }

  const metadata = new Map<string, CodexSessionMetadata>();
  let available = false;
  for (const record of records) {
    if (isRecord(record) && record.type === "status" && record.available === true) {
      available = true;
      continue;
    }
    const entry = remoteMetadataFromRecord(record);
    if (entry) metadata.set(entry.sessionId, entry);
  }
  return { entries: metadata, available };
}
