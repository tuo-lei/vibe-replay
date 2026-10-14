import { randomUUID } from "node:crypto";

/**
 * Row output for the `sqlite3` executable that stays linear in the size of the data.
 *
 * `sqlite3 -json` escapes every `"` and `\` in a string with a pass that is quadratic in
 * the string's length (sqlite 3.51: 200 KB of quotes takes 30 s, 1.5 MB of Cursor request
 * context 14 s, versus 25 ms for any other mode). Cursor stores JSON documents as TEXT, so
 * such values are the norm there. `-quote -header` prints SQL literals instead — only `'`
 * is doubled — and is parsed here into the same `Record<string, any>[]` shape.
 *
 * Windows keeps `-json`: its console stream may translate the newlines embedded in quoted
 * text to `\r\n`, which JSON output (which escapes them) does not suffer from.
 */
const USE_QUOTE_MODE = process.platform !== "win32";

/** CLI flags that select the row format `parseSqliteCliRows` understands. */
export const SQLITE_CLI_ROW_FLAGS: readonly string[] = USE_QUOTE_MODE
  ? ["-quote", "-header"]
  : ["-json"];

type QuoteValue = string | number | null;

function parseQuoteRows(output: string): QuoteValue[][] {
  const rows: QuoteValue[][] = [];
  const length = output.length;
  let row: QuoteValue[] = [];
  let i = 0;

  while (i < length) {
    const code = output.charCodeAt(i);
    let value: QuoteValue;
    if (code === 39) {
      // 'text' — a doubled quote is an escaped quote; text may span lines.
      let end = i + 1;
      for (;;) {
        end = output.indexOf("'", end);
        if (end < 0) throw new Error("Unterminated sqlite quoted string");
        if (output.charCodeAt(end + 1) !== 39) break;
        end += 2;
      }
      const raw = output.slice(i + 1, end);
      value = raw.includes("''") ? raw.replaceAll("''", "'") : raw;
      i = end + 1;
    } else if (code === 78 && output.startsWith("NULL", i)) {
      value = null;
      i += 4;
    } else if (code === 88 && output.charCodeAt(i + 1) === 39) {
      // X'hex' — render BLOBs as UTF-8 text, like `-json` (3.45) and the sql.js readers do.
      const end = output.indexOf("'", i + 2);
      if (end < 0) throw new Error("Unterminated sqlite blob literal");
      value = Buffer.from(output.slice(i + 2, end), "hex").toString("utf8");
      i = end + 1;
    } else {
      let end = i;
      while (end < length) {
        const c = output.charCodeAt(end);
        if (c === 44 || c === 10) break;
        end++;
      }
      const token = output.slice(i, end);
      const parsed = token === "Inf" ? Infinity : token === "-Inf" ? -Infinity : Number(token);
      if (token.length === 0 || Number.isNaN(parsed)) {
        throw new Error(`Unrecognized sqlite value: ${token.slice(0, 40)}`);
      }
      value = parsed;
      i = end;
    }
    row.push(value);

    const next = output.charCodeAt(i);
    if (next === 44) {
      i++;
    } else if (next === 10 || i >= length) {
      rows.push(row);
      row = [];
      i++;
    } else {
      throw new Error("Malformed sqlite quote output");
    }
  }
  return rows;
}

/** Parse the stdout of one statement run with `SQLITE_CLI_ROW_FLAGS`. */
export function parseSqliteCliRows(stdout: string): Record<string, any>[] {
  if (!USE_QUOTE_MODE) {
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as Record<string, any>[]) : [];
  }
  if (!stdout) return [];
  const [header, ...body] = parseQuoteRows(stdout);
  if (!header) return [];
  const names = header.map(String);
  return body.map((values) => {
    const record: Record<string, any> = {};
    names.forEach((name, index) => {
      record[name] = values[index] ?? null;
    });
    return record;
  });
}

/**
 * Several statements in one `sqlite3` run print their results back to back, and an empty
 * result prints nothing, so they cannot be told apart by position. Interleave
 * `.print <marker>` between statements and split on the marker (a fresh random value per
 * call, so no stored text can contain it).
 */
export function sqliteCliResultSeparator(): { marker: string; command: string } {
  const marker = `@@vibe-replay-${randomUUID()}@@`;
  return { marker, command: `.print ${marker}` };
}

export function parseSqliteCliResultSets(stdout: string, marker: string): Record<string, any>[][] {
  return stdout
    .split(marker)
    .map((part, index) => parseSqliteCliRows(index === 0 ? part : part.replace(/^\r?\n/, "")));
}
