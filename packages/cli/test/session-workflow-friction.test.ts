import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { diagnoseSession, exportSession, loadCliSession } from "../src/session-workflows.js";
import { querySessionPage } from "../src/session-query.js";
import { loadOverlays } from "../src/overlays.js";
import { saveAnnotations, saveOverlays } from "../src/server-persistence.js";
import type { ReplaySession, SessionInfo } from "../src/types.js";

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "vibe-friction-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
function replay(count = 30): ReplaySession {
  return {
    meta: {
      sessionId: "friction-session",
      provider: "codex",
      slug: "friction",
      title: "Build incident",
      stats: { userPrompts: 1, toolCalls: count - 1, sceneCount: count, thinkingBlocks: 0 },
    },
    scenes: [
      { type: "user-prompt", content: "Original customer details" },
      ...Array.from({ length: count - 1 }, (_, i) => ({
        type: "tool-call" as const,
        toolName: "Bash",
        input: { command: `step ${i + 1}` },
        result: `Failed step ${i + 1}`,
        isError: true,
      })),
    ],
  } as ReplaySession;
}

it.each([30, 500])(
  "refuses damaged saved edits for a %s-scene replay without modifying files",
  async (count) => {
    const dir = await root();
    const raw = JSON.stringify(replay(count));
    await writeFile(join(dir, "replay.json"), raw);
    expect((await loadCliSession(dir)).replay.scenes).toHaveLength(count); // Optional absence works.
    const valid = JSON.stringify({
      version: 1,
      overlays: [
        { sceneIndex: 0, modifiedValue: "Customer details removed", updatedAt: "2026-10-10" },
      ],
    });
    await writeFile(join(dir, "overlays.json"), valid);
    expect((await loadCliSession(dir)).replay.scenes[0]).toMatchObject({
      content: "Customer details removed",
    });
    for (const broken of [
      "{",
      '{"version":1,"overlays":{}}',
      '{"version":1,"overlays":[{}]}',
      '{"version":1,"overlays":[{"sceneIndex":0,"modifiedValue":null,"updatedAt":"today"}]}',
      JSON.stringify({
        version: 1,
        overlays: [{ sceneIndex: count, modifiedValue: "edit", updatedAt: "today" }],
      }),
    ]) {
      await writeFile(join(dir, "overlays.json"), broken);
      await expect(loadCliSession(dir)).rejects.toMatchObject({
        code: "invalid-sidecar",
        message: expect.stringContaining("--source"),
      });
      expect(await readFile(join(dir, "overlays.json"), "utf-8")).toBe(broken);
      expect(await readFile(join(dir, "replay.json"), "utf-8")).toBe(raw);
    }
    await rm(join(dir, "overlays.json"));
    await mkdir(join(dir, "overlays.json"));
    await expect(loadCliSession(dir)).rejects.toMatchObject({ code: "invalid-sidecar" });
    await rm(join(dir, "overlays.json"), { recursive: true });
    await writeFile(join(dir, "overlays.json"), valid);
    await writeFile(join(dir, "annotations.json"), "{}");
    await expect(loadCliSession(dir)).rejects.toMatchObject({ code: "invalid-sidecar" });
    await writeFile(join(dir, "annotations.json"), "[]");
    expect((await loadCliSession(dir)).replay.scenes[0]).toMatchObject({
      content: "Customer details removed",
    });
  },
);

it("atomically replaces sidecars and keeps the permissive editor reader compatible", async () => {
  const base = await root();
  const dir = join(base, "saved");
  await mkdir(dir);
  await writeFile(join(dir, "overlays.json"), "{");
  expect(await loadOverlays(base, "saved", undefined, false)).toEqual({ version: 1, overlays: [] });
  await Promise.all(
    Array.from({ length: 8 }, () => saveOverlays(base, "saved", { version: 1, overlays: [] })),
  );
  await saveAnnotations(base, "saved", []);
  expect(JSON.parse(await readFile(join(dir, "overlays.json"), "utf-8"))).toEqual({
    version: 1,
    overlays: [],
  });
  expect((await readdir(dir)).sort()).toEqual(["annotations.json", "overlays.json"]);
});

it("keeps cross-format audit paths bound to their actual artifact bytes", async () => {
  const dir = await root();
  const session = replay();
  const tool = session.scenes[1] as Extract<ReplaySession["scenes"][number], { type: "tool-call" }>;
  tool.result = `ghp_${"a".repeat(40)}`; // Artificial credential-like canary.
  const md = await exportSession(session, dir, "markdown");
  const json = await exportSession(session, dir, "json");
  const before = await readFile(json.redactionsPath, "utf-8");
  await exportSession(session, dir, "markdown");
  expect(md.redactionsPath).not.toBe(json.redactionsPath);
  expect(await readFile(json.redactionsPath, "utf-8")).toBe(before);
  expect(JSON.parse(before)).toMatchObject({
    source: "replay.json",
    format: "json",
    artifactSha256: createHash("sha256")
      .update(await readFile(json.path))
      .digest("hex"),
    contentRevision: expect.any(String),
  });
  expect(json.potentialSecretCount).toBe(1);
  expect(md.potentialSecretCount).toBe(0);
});

it("makes every diagnostic signal reachable with explicit independent totals", () => {
  const session = replay(500);
  session.meta.apiErrors = Array.from({ length: 4 }, (_, i) => ({
    timestamp: `2026-10-10T00:00:0${i}Z`,
    status: 429,
  })) as ReplaySession["meta"]["apiErrors"];
  session.meta.compactions = Array.from({ length: 7 }, (_, i) => ({
    timestamp: `2026-10-10T00:00:0${i}Z`,
  })) as ReplaySession["meta"]["compactions"];
  const indices: number[] = [];
  let offset = 0;
  const first = diagnoseSession(session, undefined, 100);
  expect(first.pagination.apiErrors).toMatchObject({ total: 4, returned: 4, truncated: false });
  expect(first.pagination.compactions).toMatchObject({ total: 7, returned: 7, truncated: false });
  do {
    const page = diagnoseSession(session, undefined, 100, offset);
    indices.push(...page.toolErrors.map((e) => e.index));
    offset = page.pagination.toolErrors.nextOffset ?? 500;
  } while (offset < 500);
  expect(indices).toEqual(Array.from({ length: 499 }, (_, i) => i + 1));
  expect(diagnoseSession(session, undefined, 100, 400).pagination.toolErrors).toMatchObject({
    total: 499,
    returned: 99,
    truncated: false,
  });
  const changed = structuredClone(session);
  changed.meta.apiErrors = [];
  expect(diagnoseSession(changed).signalRevision).not.toBe(first.signalRevision);
});

it("paginates tied session timestamps deterministically and rejects a changed catalog", async () => {
  const sessions = Array.from(
    { length: 205 },
    (_, i) =>
      ({
        provider: "codex",
        sessionId: `session-${String(i).padStart(3, "0")}`,
        slug: `session-${i}`,
        project: "/repo",
        cwd: "/repo",
        timestamp: "2026-10-10",
        firstPrompt: "Build failure",
        filePath: `/repo/${i}.jsonl`,
        filePaths: [`/repo/${i}.jsonl`],
        lineCount: 1,
        fileSize: 1,
        version: "",
      }) satisfies SessionInfo,
  );
  const options = { project: "repo", query: "build", provider: "codex", limit: 100, any: true };
  const first = await querySessionPage(sessions, options);
  const refreshedMetrics = sessions.map((session) => ({
    ...session,
    toolCallCount: 100,
    fileSize: 200,
  }));
  expect(
    (await querySessionPage(refreshedMetrics, { ...options, revision: first.pagination.revision }))
      .pagination.revision,
  ).toBe(first.pagination.revision);
  const second = await querySessionPage([...sessions].toReversed(), {
    ...options,
    offset: first.pagination.nextOffset,
    revision: first.pagination.revision,
  });
  const last = await querySessionPage(sessions, {
    ...options,
    offset: second.pagination.nextOffset,
    revision: first.pagination.revision,
  });
  expect(first.pagination).toMatchObject({
    total: 205,
    returned: 100,
    truncated: true,
    nextOffset: 100,
  });
  expect(last.pagination).toMatchObject({ total: 205, returned: 5, truncated: false });
  expect([...first.sessions, ...second.sessions, ...last.sessions].map((s) => s.sessionId)).toEqual(
    sessions.map((s) => s.sessionId),
  );
  await expect(
    querySessionPage(sessions.slice(1), {
      ...options,
      offset: 100,
      revision: first.pagination.revision,
    }),
  ).rejects.toMatchObject({ code: "revision-mismatch" });
});
