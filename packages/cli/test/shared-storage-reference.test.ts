import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/types.js";

let sessions: SessionInfo[] = [];
vi.mock("../src/provider-discovery.js", () => ({
  discoverProvidersSafely: async () => ({ sessions, failedProviders: [], coverage: [] }),
}));
vi.mock("../src/cache.js", () => ({
  readFileCache: async () => null,
  writeFileCache: async () => {},
}));
const { loadCliSession, resolveCliSource } = await import("../src/session-workflows.js");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["cursor", "opencode"])(
  "rejects shared %s DB paths and resolves explicit native IDs or markers",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-shared-storage-"));
    roots.push(root);
    const db = join(root, "index.db");
    await writeFile(db, "Shared storage");
    sessions = ["agent-first", "agent-second"].map((sessionId) => ({
      provider,
      sessionId,
      slug: sessionId,
      filePath: provider === "cursor" ? db : `${db}#session:${sessionId}`,
      filePaths: [],
      project: root,
      cwd: root,
      version: "",
      timestamp: "2026-10-04T00:00:00Z",
      firstPrompt: sessionId,
      lineCount: 1,
      fileSize: 1,
    }));
    await expect(loadCliSession(db, { provider })).rejects.toMatchObject({ code: "ambiguous" });
    await expect(
      loadCliSession(db, { provider, preferReplay: true, readOnly: true }),
    ).rejects.toMatchObject({ code: "ambiguous" });
    expect((await resolveCliSource(`${db}#session:agent-second`, { provider })).info).toBe(
      sessions[1],
    );
    expect((await resolveCliSource("agent-second", { provider })).info).toBe(sessions[1]);
    sessions = [sessions[1]];
    expect((await resolveCliSource(db, { provider })).info).toBe(sessions[0]);
  },
);

it.each(["opencode", "hermes"])(
  "infers a raw %s database before resolving its sessions",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-native-storage-"));
    roots.push(root);
    const folder = join(root, provider === "hermes" ? ".hermes" : "opencode");
    await mkdir(folder);
    const db = join(folder, provider === "hermes" ? "state.db" : "opencode.db");
    await writeFile(db, "SQLite format 3\0");
    sessions = ["first", "second"].map((sessionId) => ({
      provider,
      sessionId,
      slug: sessionId,
      filePath: `${db}#session:${sessionId}`,
      filePaths: [],
      project: root,
      cwd: root,
      version: "",
      timestamp: "2026-10-04T00:00:00Z",
      firstPrompt: sessionId,
      lineCount: 1,
      fileSize: 1,
    }));
    await expect(resolveCliSource(db)).rejects.toMatchObject({ code: "ambiguous" });
    sessions = [sessions[1]];
    const resolved = await resolveCliSource(db);
    expect(resolved.provider).toBe(provider);
    expect(resolved.info).toBe(sessions[0]);
  },
);
