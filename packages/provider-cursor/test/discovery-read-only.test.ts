import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { GLOBAL_STATE_IDS, globalStateDbBytes } from "./helpers/global-state-db.js";

const home = join(tmpdir(), `vibe-cursor-readonly-${Date.now()}`);
vi.mock("node:os", async () => ({ ...(await vi.importActual("node:os")), homedir: () => home }));
const { cacheWrite } = vi.hoisted(() => ({ cacheWrite: vi.fn(async () => {}) }));
vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async () => null,
  writeFileCache: cacheWrite,
}));
const { discoverCursorSessions } = await import("../src/cursor/discover.js");

beforeAll(async () => {
  const folder = join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "state.vscdb"), await globalStateDbBytes());
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

it("reads real Cursor global-state sessions without persisting a cache and separates writable in-flight scans", async () => {
  const readonly = discoverCursorSessions({ readOnly: true });
  expect(discoverCursorSessions({ readOnly: true })).toBe(readonly);
  expect((await readonly).map((session) => session.sessionId).sort()).toEqual(GLOBAL_STATE_IDS);
  expect(cacheWrite).not.toHaveBeenCalled();
  const writable = discoverCursorSessions();
  const concurrentReadonly = discoverCursorSessions({ readOnly: true });
  expect(concurrentReadonly).not.toBe(writable);
  await Promise.all([writable, concurrentReadonly]);
  expect(cacheWrite).toHaveBeenCalledTimes(1);
});
