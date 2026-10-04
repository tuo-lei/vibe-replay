/// <reference path="../sql-js.d.ts" />
import type { Database } from "sql.js";

const prepared = new WeakMap<Database, { all: boolean; sessions: Set<string> }>();

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Adapt the v2 store inside the WASM snapshot only; never write the source DB. */
export function prepareOpencodeStorage(db: Database, sessionId?: string): void {
  const previous = prepared.get(db);
  if (previous?.all || (sessionId && previous?.sessions.has(sessionId))) return;
  const tables = new Set(
    db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values.map((r) => r[0]),
  );
  const hasV2 = tables.has("session_v2") && tables.has("session_message");
  const hasLegacy = tables.has("session") && tables.has("message") && tables.has("part");
  if (!hasV2 && hasLegacy) {
    prepared.set(db, { all: true, sessions: new Set() });
    return;
  }
  if (!hasV2) {
    throw new Error(
      "Unsupported OpenCode database schema: expected session/message/part or session_v2/session_message",
    );
  }

  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const v2Columns = db
    .exec("PRAGMA main.table_info(session_v2)")[0]
    .values.map((r) => String(r[1]));
  const legacyColumns = new Set(
    db.exec("PRAGMA main.table_info(session)")[0]?.values.map((r) => String(r[1])),
  );
  const legacySessions = hasLegacy
    ? `UNION ALL SELECT ${v2Columns.map((c) => (legacyColumns.has(c) ? `s.${quote(c)}` : "NULL")).join(", ")}
       FROM main.session s WHERE NOT EXISTS (SELECT 1 FROM main.session_v2 v WHERE v.id = s.id)`
    : "";
  db.run(`
    CREATE TEMP VIEW IF NOT EXISTS session AS SELECT * FROM main.session_v2 ${legacySessions};
    CREATE TEMP TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, seq INTEGER, data TEXT);
    CREATE TEMP TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  if (hasLegacy) {
    // Retain legacy-only sessions; a v2 session ID owns its complete trajectory.
    db.run(
      `INSERT OR IGNORE INTO temp.message
      SELECT id, session_id, time_created, time_created, data FROM main.message m
      WHERE ${sessionId ? "m.session_id = ? AND" : ""} NOT EXISTS (SELECT 1 FROM main.session_v2 v WHERE v.id = m.session_id)`,
      sessionId ? [sessionId] : [],
    );
    db.run(
      `INSERT OR IGNORE INTO temp.part SELECT id, message_id, session_id, time_created, data FROM main.part p
      WHERE ${sessionId ? "p.session_id = ? AND" : ""} NOT EXISTS (SELECT 1 FROM main.session_v2 v WHERE v.id = p.session_id)`,
      sessionId ? [sessionId] : [],
    );
  }
  const rows =
    db.exec(
      `SELECT id, session_id, type, seq, time_created, data FROM main.session_message m
    WHERE ${sessionId ? "session_id = ? AND" : ""} NOT EXISTS (SELECT 1 FROM temp.message converted WHERE converted.id = m.id)
    ORDER BY session_id, seq`,
      sessionId ? [sessionId] : [],
    )[0]?.values || [];
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
          type === "compaction"
            ? data.status === "running" || data.status === "failed"
              ? "compaction"
              : "user"
            : type === "synthetic"
              ? "user"
              : type === "shell"
                ? "assistant"
                : type,
        time,
        tokens: data.tokens
          ? {
              ...object(data.tokens),
              output: (object(data.tokens).output || 0) + (object(data.tokens).reasoning || 0),
            }
          : undefined,
        _v2Message: true,
        _v2SkillName:
          type === "skill" && typeof data.name === "string" ? data.name.trim() : undefined,
        _v2Compaction: type === "compaction",
        _compactionStatus: type === "compaction" ? data.status : undefined,
        _compactionReason: type === "compaction" ? data.reason : undefined,
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
            url:
              typeof f.data === "string" && f.data && typeof f.mime === "string"
                ? `data:${f.mime};base64,${f.data}`
                : f.uri || f.url || object(f.source).uri,
            mime: f.mime,
            filename: f.name || f.filename,
          });
        }
      } else if (type === "compaction") {
        // Earlier v2 records had no lifecycle status and represent completed snapshots.
        if (data.status === undefined || data.status === "completed")
          parts = [{ type: "compaction", auto: data.reason !== "manual" }];
      } else if (type === "shell") {
        parts = [
          {
            type: "tool",
            tool: "bash",
            callID: data.shellID || data.callID || String(id),
            state: {
              status:
                data.status === "running"
                  ? "running"
                  : data.status === "timeout" ||
                      data.status === "killed" ||
                      (typeof data.exit === "number" && data.exit !== 0)
                    ? "error"
                    : "completed",
              input: { command: data.command },
              output:
                typeof data.output === "string"
                  ? data.output
                  : typeof object(data.output).output === "string"
                    ? object(data.output).output
                    : "",
              metadata: { exitCode: data.exit, shellStatus: data.status },
              time: { start: time.created, end: time.completed },
            },
          },
        ];
      } else if (type === "assistant") {
        parts = (Array.isArray(data.content) ? data.content : [])
          .filter((value) => {
            const content = object(value);
            // Partial arguments are not an invocation until the tool starts running.
            return content.type !== "tool" || object(content.state).status !== "streaming";
          })
          .map((value) => {
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
                images: (Array.isArray(state.content) ? state.content : [])
                  .map(object)
                  .filter(
                    (item) =>
                      item.type === "file" &&
                      typeof item.uri === "string" &&
                      typeof item.mime === "string" &&
                      item.mime.startsWith("image/"),
                  )
                  .map((item) => item.uri),
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
    const state = previous || { all: false, sessions: new Set<string>() };
    if (sessionId) state.sessions.add(sessionId);
    else state.all = true;
    prepared.set(db, state);
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
