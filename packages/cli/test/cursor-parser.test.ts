import { describe, it, expect } from "vitest";
import { parseCursorSession } from "../src/providers/cursor/parser.js";
import { transformToReplay } from "../src/transform.js";
import { join } from "node:path";

const FIXTURE = join(import.meta.dirname, "fixtures/cursor-session.jsonl");
const TOOL_FIXTURE_1 = join(import.meta.dirname, "fixtures/cursor-tool-1.txt");
const TOOL_FIXTURE_2 = join(import.meta.dirname, "fixtures/cursor-tool-2.txt");

describe("Cursor parser", () => {
  it("parses all turns", async () => {
    const result = await parseCursorSession(FIXTURE);
    expect(result.turns.length).toBe(10); // 3 user + 7 assistant
  });

  it("identifies user vs assistant roles", async () => {
    const result = await parseCursorSession(FIXTURE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    expect(userTurns.length).toBe(3);
    expect(assistantTurns.length).toBe(7);
  });

  it("strips <user_query> wrapper from user prompts", async () => {
    const result = await parseCursorSession(FIXTURE);
    const firstUser = result.turns.find((t) => t.role === "user")!;
    const text = (firstUser.blocks[0] as any).text;
    expect(text).not.toContain("<user_query>");
    expect(text).not.toContain("</user_query>");
    expect(text).toBe("Fix the login bug in auth.ts");
  });

  it("handles prompts without <user_query> wrapper", async () => {
    const result = await parseCursorSession(FIXTURE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    const third = userTurns[2];
    const text = (third.blocks[0] as any).text;
    expect(text).toBe("Now add rate limiting");
  });

  it("derives session ID from filename", async () => {
    const result = await parseCursorSession(FIXTURE);
    expect(result.sessionId).toBe("cursor-session");
  });

  it("extracts title from first user prompt", async () => {
    const result = await parseCursorSession(FIXTURE);
    expect(result.title).toContain("Fix the login bug");
  });
});

describe("Cursor → transform", () => {
  it("produces user prompts, text responses, and inferred tool calls", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");

    const types = new Set(replay.scenes.map((s) => s.type));
    expect(types).toEqual(new Set(["user-prompt", "text-response", "tool-call"]));
  });

  it("creates correct scene count", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");

    expect(replay.meta.stats.userPrompts).toBe(3);
    expect(replay.meta.stats.toolCalls).toBe(1);
    expect(replay.meta.stats.sceneCount).toBe(replay.scenes.length);
  });

  it("preserves assistant text content", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");

    const responses = replay.scenes.filter((s) => s.type === "text-response");
    expect(responses.length).toBe(6);
    expect(responses[0].content).toContain("look at the auth.ts file");
  });

  it("populates metadata", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");

    expect(replay.meta.provider).toBe("cursor");
    expect(replay.meta.project).toBe("~/test/project");
    // Cursor has no duration info
    expect(replay.meta.stats.durationMs).toBeUndefined();
  });
});

describe("Cursor parser — multi-file", () => {
  it("accepts array of file paths", async () => {
    // Passing the same file twice simulates multi-part sessions
    const result = await parseCursorSession([FIXTURE, FIXTURE]);
    const userTurns = result.turns.filter((t) => t.role === "user");
    expect(userTurns.length).toBe(6); // 3 * 2
  });
});

describe("Cursor parser — tool outputs", () => {
  it("maps explicit tool output files into tool-call scenes", async () => {
    const parsed = await parseCursorSession([FIXTURE, TOOL_FIXTURE_1, TOOL_FIXTURE_2]);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");

    const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");
    expect(toolScenes.length).toBe(2);
    expect(replay.meta.stats.toolCalls).toBe(2);
    expect(toolScenes[0].toolName).toBe("Diff");
    expect(toolScenes[0].result).toContain("diff --git");
    expect(toolScenes[1].toolName).toBe("WebFetch");
    expect(toolScenes[1].result).toContain("https://example.com/docs");
  });

  it("keeps inferred marker tool when no explicit output is provided", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");
    const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");
    expect(toolScenes.length).toBe(1);
    expect(toolScenes[0].toolName).toBe("Searching for auth files");
    expect(toolScenes[0].result).toBe("");
  });
});
