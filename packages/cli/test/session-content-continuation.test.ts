import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { contentRevision, inspectSession, loadCliSession } from "../src/session-workflows.js";
import type { ReplaySession } from "../src/types.js";

function session(count: number): ReplaySession {
  return {
    meta: {
      sessionId: "continuation-session",
      provider: "codex",
      slug: "continuation",
      cwd: "/repo",
      project: "/repo",
      startTime: "2026-10-06T00:00:00Z",
      stats: { sceneCount: count, userPrompts: 1, toolCalls: count - 1, thinkingBlocks: 0 },
    },
    scenes: Array.from({ length: count }, (_, index) =>
      index === 0
        ? { type: "user-prompt", content: "Find the build failure" }
        : {
            type: "tool-call",
            toolName: "Bash",
            input: { command: `logs ${index}` },
            result: `${"long output\n".repeat(500)}EUSAGE ${index}`,
            isError: false,
          },
    ),
  };
}

it.each([30, 500])(
  "continues query matches by scene address without repeats in a %i-scene replay",
  (count) => {
    const replay = session(count);
    const seen: number[] = [];
    let offset = 0;
    for (;;) {
      const page = inspectSession(replay, { query: "EUSAGE", offset, limit: 7 });
      expect(page).toHaveProperty("scenes");
      const content = page as Extract<typeof page, { scenes: unknown }>;
      seen.push(...content.scenes.map((scene) => scene.index));
      if (content.nextOffset === undefined) break;
      expect(content.nextOffset).toBeGreaterThan(offset);
      offset = content.nextOffset;
    }
    expect(seen).toEqual(Array.from({ length: count - 1 }, (_, index) => index + 1));
  },
);

it("reports hidden characters separately from omitted scenes and returns lossless bounded field pages", () => {
  const replay = session(2);
  const original = replay.scenes[1] as Extract<
    ReplaySession["scenes"][number],
    { type: "tool-call" }
  >;
  const first = inspectSession(replay, { scene: 1 });
  expect(first).toMatchObject({
    truncated: false,
    scenes: [
      {
        resultTruncated: true,
        fields: {
          result: { length: original.result.length, offset: 0, end: 2000, nextOffset: 2000 },
        },
      },
    ],
  });
  let value = "",
    offset = 0;
  for (;;) {
    const page = inspectSession(replay, {
      scene: 1,
      field: "result",
      textOffset: offset,
      textLimit: 1000,
    });
    const content = (page as Extract<typeof page, { scenes: unknown }>).scenes[0].content!;
    expect(content.value.length).toBeLessThanOrEqual(1000);
    value += content.value;
    if (content.nextOffset === undefined) break;
    offset = content.nextOffset;
  }
  expect(value).toBe(original.result);
  expect(() => inspectSession(replay, { scene: 0, field: "result" })).toThrow(
    "has no result field",
  );
  expect(() =>
    inspectSession(replay, { scene: 1, textOffset: original.result.length + 10000 }),
  ).toThrow("--text-offset");
});

it("keeps revisions stable across generation time and JSON formatting, but binds effective content", () => {
  const replay = session(2),
    copied = JSON.parse(JSON.stringify(replay)) as ReplaySession;
  copied.meta.generator = { name: "vibe-replay", version: "test", generatedAt: "2099-01-01" };
  const tool = copied.scenes[1] as Extract<ReplaySession["scenes"][number], { type: "tool-call" }>;
  const reordered = { ...tool, input: { z: "last", a: "first" } };
  replay.scenes[1] = { ...tool, input: { a: "first", z: "last" } };
  copied.scenes[1] = reordered;
  expect(contentRevision(copied)).toBe(contentRevision(replay));
  tool.result = "different log";
  copied.scenes[1] = tool;
  expect(contentRevision(copied)).not.toBe(contentRevision(replay));
});

it("loads a renamed handoff itself without borrowing a neighboring replay's sidecars or publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-renamed-handoff-"));
  try {
    const handoff = session(2),
      neighbor = session(3),
      path = join(root, "incident.json");
    await writeFile(path, JSON.stringify(handoff));
    await writeFile(join(root, "replay.json"), JSON.stringify(neighbor));
    await writeFile(
      join(root, "overlays.json"),
      JSON.stringify({
        version: 1,
        overlays: [
          { sceneIndex: 0, modifiedValue: "Neighbor's private edit", updatedAt: "2026-10-06" },
        ],
      }),
    );
    await writeFile(
      join(root, "annotations.json"),
      JSON.stringify([{ id: "neighbor", sceneIndex: 0, body: "private" }]),
    );
    const before = await readFile(path);
    const loaded = await loadCliSession(path, {
      snapshot: true,
      revision: contentRevision(handoff),
    });
    expect(loaded.replay).toEqual(handoff);
    expect(loaded.publicationDir).toBeUndefined();
    expect(loaded.provenance).toMatchObject({ origin: "snapshot", sceneCount: 2 });
    await expect(loadCliSession(path, { revision: contentRevision(neighbor) })).rejects.toThrow(
      "revision mismatch",
    );
    await expect(loadCliSession(path, { source: true })).rejects.toThrow("requires a source");
    await expect(loadCliSession(path, { provider: "pi" })).rejects.toThrow("Replay provider");
    await expect(loadCliSession(path, { target: "remote" })).rejects.toThrow("Replay belongs");
    await writeFile(join(root, "no-extension"), JSON.stringify(handoff));
    expect((await loadCliSession(join(root, "no-extension"))).replay).toEqual(handoff);
    await writeFile(
      join(root, "invalid.json"),
      JSON.stringify({ meta: handoff.meta, scenes: [{ type: "tool-call" }] }),
    );
    await expect(loadCliSession(join(root, "invalid.json"))).rejects.toThrow("Invalid replay JSON");
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
