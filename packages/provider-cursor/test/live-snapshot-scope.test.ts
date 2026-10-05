import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { GLOBAL_STATE_IDS, globalStateDbBytes, testSqlite } from "./helpers/global-state-db.js";

const state = vi.hoisted(() => ({ home: "", source: "", copies: [] as string[], queries: 0 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => state.home,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (source: string, destination: string, flags?: number) => {
      if (source === state.source) state.copies.push(destination);
      await actual.copyFile(source, destination, flags);
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Execute the native backend's SQL against its real staged file, using WASM
  // only as a portable stand-in for the sqlite3 executable in this test.
  return {
    ...actual,
    execFile: Object.assign(() => {}, {
      [Symbol.for("nodejs.util.promisify.custom")]: async (_command: string, args: string[]) => {
        state.queries++;
        const json = args.includes("-json"),
          path = fileURLToPath(args[json ? 2 : 1]),
          SQL = await testSqlite(),
          db = new SQL.Database(await readFile(path));
        try {
          const result = db.exec(args[args.length - 1])[0],
            rows = result
              ? result.values.map((values) =>
                  Object.fromEntries(
                    result.columns.map((column, index) => [column, values[index]]),
                  ),
                )
              : [];
          return {
            stdout: json
              ? JSON.stringify(rows)
              : (result?.values.map((values) => values.join("|")).join("\n") ?? ""),
            stderr: "",
          };
        } finally {
          db.close();
        }
      },
    }),
  };
});

it.each(["diagnostics", "watch-paths"])(
  "reuses and cleans one native snapshot across live %s queries",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-cursor-live-scope-")),
      source = join(root, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
    try {
      state.home = root;
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, await globalStateDbBytes());
      state.source = await realpath(source);
      state.copies = [];
      state.queries = 0;
      vi.resetModules();
      const { readCursorLiveDiagnostics, resolveCursorLiveWatchPaths } =
          await import("../src/cursor/sqlite-reader.js"),
        before = await readFile(source);
      if (kind === "diagnostics") {
        expect(await readCursorLiveDiagnostics(GLOBAL_STATE_IDS[0])).toMatchObject({
          source: "global-state",
          bubbleCount: 2,
          latestTextPreview: "Done 1",
        });
      } else {
        expect(await resolveCursorLiveWatchPaths(GLOBAL_STATE_IDS[0])).toContain(source);
      }
      expect(state.queries).toBeGreaterThan(1);
      expect(state.copies).toHaveLength(1);
      await expect(stat(state.copies[0])).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(source)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
