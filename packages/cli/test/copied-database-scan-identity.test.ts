import { expect, it } from "vitest";
import { scanInputFromSession } from "../src/session-query.js";
import { scanCacheEntryKey } from "../src/scanner.js";
import type { SessionInfo } from "../src/types.js";

it("preserves the selected copied database in scanner metadata", () => {
  const session = {
    provider: "cursor",
    sessionId: "same-id",
    project: "/repo",
    sourceDatabasePath: "/copied/index.db",
  } as SessionInfo;
  expect(scanInputFromSession(session).sourceDatabasePath).toBe("/copied/index.db");
});
it("isolates copied database scan caches while retaining existing native keys", () => {
  const native = { provider: "cursor", sessionId: "same-id" };
  expect(scanCacheEntryKey(native)).toBe("cursor::same-id");
  const first = scanCacheEntryKey({ ...native, sourceDatabasePath: "/one/index.db" });
  const second = scanCacheEntryKey({ ...native, sourceDatabasePath: "/two/index.db" });
  expect(first).not.toBe(second);
  expect(first).not.toBe(scanCacheEntryKey(native));
  expect(first).not.toContain("/one/index.db");
});
