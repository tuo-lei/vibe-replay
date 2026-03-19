import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSessionInfo } from "../src/providers/claude-code/discover.js";

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

  it("returns undefined title when session has no custom-title line", async () => {
    const fileStat = await stat(FIXTURE_NO_TITLE);
    const info = await extractSessionInfo(FIXTURE_NO_TITLE, fileStat.size, "/Users/test/project");

    expect(info).not.toBeNull();
    expect(info?.title).toBeUndefined();
  });
});
