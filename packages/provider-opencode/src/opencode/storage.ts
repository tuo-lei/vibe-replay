/// <reference path="../sql-js.d.ts" />
import type { Database } from "sql.js";

const prepared = new WeakSet<Database>();

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Adapt the v2 store inside the WASM snapshot only; never write the source DB. */
export function prepareOpencodeStorage(db: Database): void {
  if (prepared.has(db)) return;
  const tables = new Set(
    db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values.map((r) => r[0]),
  );
  if (tables.has("session") && tables.has("message") && tables.has("part")) {
    prepared.add(db);
    return;
  }
  if (!tables.has("session_v2") || !tables.has("session_message")) {
    throw new Error(
      "Unsupported OpenCode database schema: expected session/message/part or session_v2/session_message",
    );
  }

  const rows =
    db.exec(
      "SELECT id, session_id, type, seq, time_created, data FROM session_message ORDER BY session_id, seq",
    )[0]?.values || [];
  db.run(`
    CREATE TEMP VIEW session AS SELECT * FROM session_v2;
    CREATE TEMP TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, seq INTEGER, data TEXT);
    CREATE TEMP TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  const insert = (statement: ReturnType<Database["prepare"]>, values: any[]) => {
    statement.bind(values);
    statement.step();
    statement.reset();
  };
  try {
    for (const [id, sessionId, type, seq, created, raw] of rows) {
      let data: Record<string, any>;
      try {
        data = object(JSON.parse(String(raw)));
      } catch {
        insert(message, [id, sessionId, created, seq, raw]);
        continue;
      }
      const time: Record<string, any> = { created: Number(created), ...object(data.time) };
      const meta = {
        ...data,
        role:
          type === "compaction" || type === "synthetic"
            ? "user"
            : type === "shell"
              ? "assistant"
              : type,
        time,
        modelID: object(data.model).id,
        error: data.error ? { name: object(data.error).type } : undefined,
      };
      let parts: Record<string, any>[] = [];
      if (type === "user" || type === "synthetic") {
        parts = [{ type: "text", text: data.text, synthetic: type === "synthetic" }];
        for (const file of Array.isArray(data.files) ? data.files : []) {
          const f = object(file);
          parts.push({
            type: "file",
            url: f.uri || f.url,
            mime: f.mime,
            filename: f.name || f.filename,
          });
        }
      } else if (type === "compaction") {
        parts = [{ type: "compaction", auto: data.reason !== "manual" }];
      } else if (type === "shell") {
        parts = [
          {
            type: "tool",
            tool: "bash",
            callID: data.callID,
            state: {
              status: "completed",
              input: { command: data.command },
              output: data.output,
              time: { start: time.created, end: time.completed },
            },
          },
        ];
      } else if (type === "assistant") {
        parts = (Array.isArray(data.content) ? data.content : []).map((value) => {
          const content = object(value);
          if (content.type !== "tool") return content;
          const state = object(content.state);
          const toolTime = object(content.time);
          const metadata = { ...object(state.metadata), ...object(state.structured) };
          const output = (Array.isArray(state.content) ? state.content : [])
            .map((item) => object(item).text)
            .filter((text) => typeof text === "string")
            .join("\n");
          return {
            type: "tool",
            tool: content.name,
            callID: content.id,
            state: {
              ...state,
              status: metadata.error === true ? "error" : state.status,
              output: output || object(state.error).message || "",
              metadata: { ...metadata, sessionId: metadata.sessionId || metadata.sessionID },
              time: { start: toolTime.ran || toolTime.created, end: toolTime.completed },
            },
          };
        });
      }
      insert(message, [id, sessionId, created, seq, JSON.stringify(meta)]);
      parts.forEach((data, index) =>
        insert(part, [
          `${id}:${String(index).padStart(8, "0")}`,
          id,
          sessionId,
          Number(created),
          JSON.stringify(data),
        ]),
      );
    }
    prepared.add(db);
  } finally {
    message.free();
    part.free();
  }
}

export function opencodeMessageOrder(db: Database): string {
  return db.exec("PRAGMA table_info(message)")[0]?.values.some((r) => r[1] === "seq")
    ? "seq ASC"
    : "time_created ASC";
}
