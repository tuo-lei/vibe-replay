import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  SQLITE_CLI_ROW_FLAGS,
  parseSqliteCliResultSets,
  parseSqliteCliRows,
  sqliteCliResultSeparator,
} from "../src/sqlite-cli.js";

const hasSqlite3 = spawnSync("sqlite3", ["--version"]).status === 0;
const quoteMode = SQLITE_CLI_ROW_FLAGS.includes("-quote");

function run(flags: readonly string[], ...sql: string[]): string {
  return execFileSync("sqlite3", [...flags, ":memory:", ...sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

describe("parseSqliteCliRows (quote format)", () => {
  it.skipIf(!quoteMode)("parses every value kind", () => {
    const out = [
      "'id','name','n','r','z','blob'",
      "1,'it''s','multi",
      "line\\\"q\"',-2.5,NULL,X'414243'",
      "",
    ].join("\n");
    expect(parseSqliteCliRows(out)).toEqual([
      { id: 1, name: "it's", n: 'multi\nline\\"q"', r: -2.5, z: null, blob: "ABC" },
    ]);
  });

  it.skipIf(!quoteMode)("handles empty output, empty strings, and no trailing newline", () => {
    expect(parseSqliteCliRows("")).toEqual([]);
    expect(parseSqliteCliRows("'a','b'\n'',''''\n")).toEqual([{ a: "", b: "'" }]);
    expect(parseSqliteCliRows("'a'\n7")).toEqual([{ a: 7 }]);
  });

  it.skipIf(!quoteMode)("rejects malformed output instead of guessing", () => {
    expect(() => parseSqliteCliRows("'a'\n'oops")).toThrow(/Unterminated/);
    expect(() => parseSqliteCliRows("'a'\nbogus")).toThrow(/Unrecognized/);
    expect(() => parseSqliteCliRows("'a'\n'x' 'y'")).toThrow(/Malformed/);
  });
});

describe("parseSqliteCliRows against the real sqlite3 CLI", () => {
  it.skipIf(!hasSqlite3)("matches -json for tricky values", () => {
    const sql = `SELECT
      'quote " back \\ slash '' tick' AS c_tricky,
      'line1
line2' AS c_multiline,
      'é中😀' AS c_unicode,
      '' AS c_empty,
      NULL AS c_null,
      7 AS c_int,
      -3 AS c_neg,
      1.5 AS c_real,
      0.1 AS c_tenth,
      1e300 AS c_huge,
      9007199254740993 AS c_big,
      x'41ff42' AS c_bytes,
      'NULL' AS null_text,
      'X''41''' AS blob_text,
      '1,2' AS comma_text;
      SELECT 1 AS only WHERE 0;`;
    const expected = JSON.parse(
      run(["-json"], sql)
        .trim()
        .split(/(?<=\])\n(?=\[)/)[0],
    );
    expect(parseSqliteCliRows(run(SQLITE_CLI_ROW_FLAGS, sql))).toEqual(expected);
  });

  it.skipIf(!hasSqlite3)("matches -json over many rows and an unusual header name", () => {
    const sql =
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) " +
      "SELECT i AS \"weird name\", printf('v%d,''q''', i) AS t FROM n";
    expect(parseSqliteCliRows(run(SQLITE_CLI_ROW_FLAGS, sql))).toEqual(
      JSON.parse(run(["-json"], sql)),
    );
  });

  it.skipIf(!hasSqlite3)("splits result sets on the marker, including empty ones", () => {
    const { marker, command } = sqliteCliResultSeparator();
    const sets = (...sql: string[]) =>
      parseSqliteCliResultSets(run(SQLITE_CLI_ROW_FLAGS, ...sql), marker);
    expect(sets("SELECT 1 AS a;", command, "SELECT 'x' AS b;")).toEqual([[{ a: 1 }], [{ b: "x" }]]);
    expect(sets("SELECT 1 AS a WHERE 0;", command, "SELECT 'x' AS b;")).toEqual([[], [{ b: "x" }]]);
    expect(sets("SELECT 1 AS a;", command, "SELECT 1 AS b WHERE 0;")).toEqual([[{ a: 1 }], []]);
    expect(sets("SELECT 1 WHERE 0;", command, "SELECT 1 WHERE 0;")).toEqual([[], []]);
  });

  // `sqlite3 -json` needs ~30 s for 200 KB of quotes (quadratic); this format must not.
  it.skipIf(!hasSqlite3 || !quoteMode)("stays fast on large quote-heavy text", () => {
    const sql =
      "SELECT replace(replace(replace(hex(zeroblob(400000)), '0', '\"'), '1', char(10)), '2', '\\') AS big";
    const started = performance.now();
    const rows = parseSqliteCliRows(run(SQLITE_CLI_ROW_FLAGS, sql));
    expect(rows).toHaveLength(1);
    expect(String(rows[0].big)).toHaveLength(800000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
