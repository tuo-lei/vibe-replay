import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diagnoseSession,
  exportSession,
  inspectSession,
  loadCliSession,
  resolveSessionReference,
  sharePreflight,
} from "../src/session-workflows.js";
import type { ReplaySession, SessionInfo } from "../src/types.js";

const replay: ReplaySession = {
  meta: {
    sessionId: "session-abcd",
    slug: "abcd",
    title: "Diagnose build",
    provider: "codex",
    cwd: "/repo",
    project: "/repo",
    startTime: "2026-10-04T00:00:00Z",
    stats: { userPrompts: 1, toolCalls: 1, sceneCount: 4, thinkingBlocks: 0 },
  },
  scenes: [
    { type: "user-prompt", content: "Why did the build fail?" },
    {
      type: "tool-call",
      toolName: "Bash",
      input: { command: "get-build-logs" },
      result: `${"x".repeat(5000)}npm error code EUSAGE: lockfile mismatch`,
      isError: false,
      hasResult: true,
    },
    {
      type: "tool-call",
      toolName: "Bash",
      input: { command: "pnpm test" },
      result: "tests failed",
      isError: true,
    },
    { type: "text-response", content: "Dependency installation failed before tests ran" },
  ],
};

function source(id: string, provider = "codex", target?: string): SessionInfo {
  return {
    provider,
    sessionId: id,
    slug: id.slice(0, 8),
    project: "/repo",
    cwd: "/repo",
    version: "",
    timestamp: "2026-10-04T00:00:00Z",
    lineCount: 1,
    fileSize: 1,
    filePath: `/${provider}/${target || "local"}/${id}.jsonl`,
    filePaths: [`/${provider}/${target || "local"}/${id}.jsonl`],
    firstPrompt: "hello",
    ...(target ? { location: { kind: "ssh" as const, id: target, label: target } } : {}),
  };
}

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "vibe-workflows-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("session references and evidence", () => {
  it("resolves IDs, aliases, unique prefixes, paths, and scoped remote sessions without guessing", () => {
    const first = { ...source("abcd1111-full"), sessionIds: ["native-alias"] };
    const second = source("abcd2222-full");
    expect(resolveSessionReference([first, second], "native-alias")).toBe(first);
    expect(resolveSessionReference([first, second], "abcd111")).toBe(first);
    expect(resolveSessionReference([first, second], first.filePath)).toBe(first);
    expect(() => resolveSessionReference([first, second], "abcd")).toThrow("Ambiguous");
    const remote = source(first.sessionId, "codex", "remote-dev");
    expect(() => resolveSessionReference([first, remote], first.sessionId)).toThrow("Ambiguous");
    expect(
      resolveSessionReference([first, remote], first.sessionId, { target: "remote-dev" }),
    ).toBe(remote);
    expect(() => resolveSessionReference([first], "missing")).toThrow("not found");
  });

  it("finds bounded result evidence even after a large tool output and exposes exact scene indices", () => {
    const result = inspectSession(replay, { query: "EUSAGE", limit: 1 });
    expect(result).toMatchObject({ matchCount: 1, truncated: false });
    expect("scenes" in result && result.scenes[0]).toMatchObject({
      index: 1,
      result: expect.stringContaining("lockfile mismatch"),
    });
    expect("scenes" in result && result.scenes[0].text.length).toBeLessThan(2100);
    const summary = inspectSession(replay);
    expect("lastResponse" in summary && summary.lastResponse).toMatchObject({
      index: 3,
      text: "Dependency installation failed before tests ran",
    });
  });

  it("keeps external error evidence separate from tool and API failure counts", () => {
    const result = diagnoseSession(replay, "EUSAGE");
    expect(result.apiErrorCount).toBe(0);
    expect(result.toolErrorCount).toBe(1);
    expect(result.toolErrors[0].index).toBe(2);
    expect(result.evidence).toMatchObject({ matchCount: 1 });
  });

  it("bounds large sessions and marks omitted matches", () => {
    const large = {
      ...replay,
      scenes: Array.from({ length: 605 }, () => ({
        type: "text-response" as const,
        content: "matching evidence",
      })),
    };
    const result = inspectSession(large, { query: "evidence", limit: 12 });
    expect(result).toMatchObject({ matchCount: 605, truncated: true });
    expect("scenes" in result && result.scenes).toHaveLength(12);
  });
});

describe("export and sharing", () => {
  it("exports Markdown without images or a viewer build, strips SSH repository identity, and leaves the original alone", async () => {
    const dir = await root();
    const remote = {
      ...replay,
      meta: {
        ...replay.meta,
        gitRepo: "private/repo",
        location: { kind: "ssh" as const, id: "remote", label: "Remote" },
      },
    };
    const result = await exportSession(remote, dir, "markdown");
    const text = await readFile(result.path, "utf-8");
    expect(text).toContain("Diagnose build");
    expect(text).not.toContain("session-preview");
    expect((await readdir(dir)).sort()).toEqual(["github-summary.md", "redactions.json"]);
    expect(remote.meta.gitRepo).toBe("private/repo");
    const json = await exportSession(remote, dir, "json");
    expect(JSON.parse(await readFile(json.path, "utf-8")).meta.gitRepo).toBeUndefined();
  });

  it("loads explicit replay paths with effective edits and annotations without modifying replay.json", async () => {
    const dir = await root();
    const raw = JSON.stringify(replay);
    await writeFile(join(dir, "replay.json"), raw);
    await writeFile(
      join(dir, "overlays.json"),
      JSON.stringify({
        version: 1,
        overlays: [
          { sceneIndex: 0, modifiedValue: "Edited request", updatedAt: "2026-10-04T01:00:00Z" },
        ],
      }),
    );
    await writeFile(
      join(dir, "annotations.json"),
      JSON.stringify([{ id: "note", sceneIndex: 1, body: "Build log", resolved: false }]),
    );
    const loaded = await loadCliSession(join(dir, "replay.json"));
    expect(loaded.replay.scenes[0]).toMatchObject({ content: "Edited request" });
    expect(loaded.replay.annotations?.[0]).toMatchObject({ id: "note" });
    expect(await readFile(join(dir, "replay.json"), "utf-8")).toBe(raw);
  });

  it("preflights the effective payload and exposes no secret matches or raw context", () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const result = sharePreflight(
      { ...replay, scenes: [{ type: "user-prompt", content: secret }] },
      "unlisted",
      true,
    );
    expect(result).toMatchObject({
      mode: "cloud",
      uploaded: false,
      potentialSecretCount: 1,
      withinCloudLimit: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(sharePreflight(replay, "private", false)).toMatchObject({
      mode: "local-fallback",
      visibility: "private",
    });
  });

  it("honors scope on explicit replay paths and clears removed annotations", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "replay.json"),
      JSON.stringify({ ...replay, annotations: [{ id: "old", sceneIndex: 0, body: "Old note" }] }),
    );
    await writeFile(join(dir, "annotations.json"), "[]");
    const loaded = await loadCliSession(dir, { provider: "codex", target: "local" });
    expect(loaded.replay.annotations).toEqual([]);
    await expect(loadCliSession(dir, { provider: "pi" })).rejects.toThrow("Replay provider");
    await expect(loadCliSession(dir, { target: "remote" })).rejects.toThrow(
      "Replay belongs to target",
    );
  });
});
