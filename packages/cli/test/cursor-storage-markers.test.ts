import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
const { resolveCliSource } = await import("../src/session-workflows.js");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["sdk", "global-state"])(
  "normalizes %s storage markers for ambiguity and provider inference",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-cursor-markers-"));
    roots.push(root);
    const folder = join(
      root,
      kind === "sdk" ? ".cursor" : "Cursor",
      kind === "sdk" ? "opencode" : "globalStorage",
    );
    await mkdir(folder, { recursive: true });
    const db = join(folder, kind === "sdk" ? "index.db" : "state.vscdb");
    await writeFile(db, "Shared storage");
    const marker = kind === "sdk" ? "#session:" : "#composerData:";
    sessions = ["agent-first", "agent-second"].map((sessionId) => ({
      provider: "cursor",
      sessionId,
      slug: sessionId,
      filePath: kind === "sdk" ? db : `${db}${marker}${sessionId}`,
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
    const selected = await resolveCliSource(`${db}${marker}agent-second`);
    expect(selected.provider).toBe("cursor");
    expect(selected.info).toBe(sessions[1]);
    await expect(resolveCliSource(`${db}${marker}`)).rejects.toThrow("must contain an ID");
    sessions = [sessions[1]];
    expect((await resolveCliSource(db)).info).toBe(sessions[0]);
  },
);

it("keeps transcript header inference ahead of Cursor directory hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-cursor-header-"));
  roots.push(root);
  const folder = join(root, ".cursor");
  await mkdir(folder);
  const transcript = join(folder, "copied-codex.jsonl");
  await writeFile(
    transcript,
    JSON.stringify({ type: "session_meta", payload: { id: "codex-session" } }),
  );
  sessions = [];
  expect((await resolveCliSource(transcript)).provider).toBe("codex");
});
