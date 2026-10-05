import { beforeEach, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), readFile: vi.fn(), stat: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: mocks.readFile,
    stat: (...args: Parameters<typeof actual.stat>) =>
      typeof args[0] === "string" && /-(wal|shm)$/.test(args[0])
        ? actual.stat(...args)
        : mocks.stat(...args),
  };
});
import { inferSqliteProvider } from "../src/sqlite-schema.js";

beforeEach(() => {
  vi.resetAllMocks();
});

it("probes a large copied database with bounded readonly sqlite3 without loading bytes", async () => {
  mocks.stat.mockResolvedValue({ size: 512 * 1024 * 1024 });
  mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(null, '[{"name":"cursorDiskKV"}]'),
  );
  expect(await inferSqliteProvider("/copied/state.snapshot")).toBe("cursor");
  expect(mocks.execFile).toHaveBeenCalledWith(
    "sqlite3",
    ["-readonly", "-json", "/copied/state.snapshot", expect.stringContaining("sqlite_master")],
    { timeout: 5000, maxBuffer: 65536 },
    expect.any(Function),
  );
  expect(mocks.readFile).not.toHaveBeenCalled();
  expect(mocks.stat).toHaveBeenCalledExactlyOnceWith("/copied/state.snapshot");
});

it("keeps portable WASM inference for a small database when sqlite3 is unavailable", async () => {
  const SQL = await initSqlJs(),
    db = new SQL.Database();
  db.run("CREATE TABLE session_v2 (id TEXT); CREATE TABLE session_message (id TEXT)");
  const bytes = db.export();
  db.close();
  mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(Object.assign(new Error("missing executable"), { code: "ENOENT" })),
  );
  mocks.stat.mockResolvedValue({ size: bytes.length });
  mocks.readFile.mockResolvedValue(bytes);
  expect(await inferSqliteProvider("/copy.db")).toBe("opencode");
  expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/copy.db");
});

it("does not load an unbounded fallback or hide a readonly probe failure", async () => {
  mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(Object.assign(new Error("missing executable"), { code: "ENOENT" })),
  );
  mocks.stat.mockResolvedValue({ size: 512 * 1024 * 1024 });
  await expect(inferSqliteProvider("/copy.db")).rejects.toThrow("specify --provider");
  expect(mocks.readFile).not.toHaveBeenCalled();
  mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(Object.assign(new Error("database locked"), { code: 1 })),
  );
  await expect(inferSqliteProvider("/copy.db")).rejects.toThrow("database locked");
  expect(mocks.readFile).not.toHaveBeenCalled();
});

it("uses the bounded portable fallback when an older sqlite3 rejects -json", async () => {
  const SQL = await initSqlJs(),
    db = new SQL.Database();
  db.run("CREATE TABLE sessions (id TEXT); CREATE TABLE messages (id TEXT)");
  const bytes = db.export();
  db.close();
  mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
    callback(Object.assign(new Error("sqlite3: Error: unknown option: -json"), { code: 1 })),
  );
  mocks.stat.mockResolvedValue({ size: bytes.length });
  mocks.readFile.mockResolvedValue(bytes);
  expect(await inferSqliteProvider("/copy.db")).toBe("hermes");
  expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/copy.db");
});
