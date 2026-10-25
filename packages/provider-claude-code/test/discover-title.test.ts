import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSessionInfo } from "../src/claude-code/discover.js";

const fixture = (name: string) => join(__dirname, "fixtures", name);
const FIXTURE_TITLE_EARLY = fixture("discover-title-early.jsonl");
const FIXTURE_TITLE_LATE = fixture("discover-title-late.jsonl");
const FIXTURE_NO_TITLE = fixture("discover-boilerplate.jsonl");

// ---------------------------------------------------------------------------
// Bug fix: discover.ts was reading obj.title instead of obj.customTitle
// and only scanning first 150 lines (custom-title is often at session end)
// ---------------------------------------------------------------------------
describe("extractSessionInfo – customTitle discovery", () => {
  it("reads customTitle when it appears early in the session (within scan limit)", async () => {
    const fileStat = await stat(FIXTURE_TITLE_EARLY);
    const info = await extractSessionInfo(
      FIXTURE_TITLE_EARLY,
      fileStat.size,
      "/Users/test/project",
    );

    expect(info).not.toBeNull();
    expect(info?.title).toBe("Early title in session");
    expect(info?.sessionId).toBe("title-early-session-1");
  });

  it("reads customTitle when it appears at session end (beyond 150-line scan limit)", async () => {
    const fileStat = await stat(FIXTURE_TITLE_LATE);
    const info = await extractSessionInfo(FIXTURE_TITLE_LATE, fileStat.size, "/Users/test/project");

    expect(info).not.toBeNull();
    expect(info?.title).toBe("Late title at session end");
    expect(info?.sessionId).toBe("title-late-session-1");
  });

  it("falls back to the latest ai-title, wherever it appears, and prefers custom-title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-cc-ai-title-"));
    try {
      const record = (value: object) => JSON.stringify(value);
      const filler = Array.from({ length: 80 }, (_, i) =>
        record({
          type: "assistant",
          sessionId: "ai-title-session",
          timestamp: `2026-01-01T00:01:${String(i % 60).padStart(2, "0")}.000Z`,
          message: { role: "assistant", content: [{ type: "text", text: `step ${i}` }] },
        }),
      );
      const head = [
        record({
          type: "user",
          sessionId: "ai-title-session",
          cwd: "/Users/test/project",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "Refactor the auth middleware" },
        }),
      ];
      const aiOnly = join(dir, "ai-only.jsonl");
      await writeFile(
        aiOnly,
        [
          ...head,
          ...filler,
          record({ type: "ai-title", aiTitle: "First AI title", sessionId: "ai-title-session" }),
          ...filler,
          record({ type: "ai-title", aiTitle: "Refined AI title", sessionId: "ai-title-session" }),
          ...filler,
        ].join("\n"),
      );
      const aiInfo = await extractSessionInfo(aiOnly, (await stat(aiOnly)).size, "/p");
      expect(aiInfo?.title).toBe("Refined AI title");

      const renamed = join(dir, "renamed.jsonl");
      await writeFile(
        renamed,
        [
          ...head,
          record({ type: "custom-title", customTitle: "User rename" }),
          ...filler,
          record({ type: "ai-title", aiTitle: "Later AI title", sessionId: "ai-title-session" }),
        ].join("\n"),
      );
      const renamedInfo = await extractSessionInfo(renamed, (await stat(renamed)).size, "/p");
      expect(renamedInfo?.title).toBe("User rename");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined title when session has no custom-title line", async () => {
    const fileStat = await stat(FIXTURE_NO_TITLE);
    const info = await extractSessionInfo(FIXTURE_NO_TITLE, fileStat.size, "/Users/test/project");

    expect(info).not.toBeNull();
    expect(info?.title).toBeUndefined();
  });
});
