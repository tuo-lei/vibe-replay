import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

const TABLE_QUERY = "SELECT name FROM sqlite_master WHERE type = 'table'";
const MAX_WASM_PROBE_BYTES = 32 * 1024 * 1024;

export async function inferSqliteProvider(path: string): Promise<string | undefined> {
  const size = (await stat(path)).size;
  if (size < 1024) return undefined;
  let names: unknown[];
  try {
    names = await new Promise<unknown[]>((resolve, reject) => {
      execFile(
        "sqlite3",
        ["-readonly", "-json", path, TABLE_QUERY],
        { timeout: 5_000, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) return reject(error);
          try {
            const rows: { name: string }[] = JSON.parse(stdout || "[]");
            resolve(rows.map((row) => row.name));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (size > MAX_WASM_PROBE_BYTES)
      throw new Error(
        "Automatic provider detection for databases larger than 32 MiB requires sqlite3. Install sqlite3 or specify --provider <name> to skip the probe.",
        { cause: error },
      );
    const bytes = await readFile(path);
    const { default: initSqlJs } = await import("sql.js");
    const SQL = await initSqlJs();
    const db = new SQL.Database(bytes);
    try {
      names = db.exec(TABLE_QUERY)[0]?.values.map((row) => row[0]) || [];
    } finally {
      db.close();
    }
  }
  const tables = new Set(names);
  if (tables.has("sessions") && tables.has("messages")) return "hermes";
  if (
    (tables.has("session_v2") && tables.has("session_message")) ||
    (tables.has("session") && tables.has("message") && tables.has("part"))
  )
    return "opencode";
  if (
    tables.has("cursorDiskKV") ||
    (tables.has("meta") && tables.has("blobs")) ||
    (tables.has("agents") && tables.has("runs") && tables.has("run_events"))
  )
    return "cursor";
  return undefined;
}
