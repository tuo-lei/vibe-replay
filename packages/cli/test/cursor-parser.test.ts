import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCursorSession } from "../src/providers/cursor/parser.js";
import { transformToReplay } from "../src/transform.js";
import type { ContentBlock } from "../src/types.js";

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type UserImagesBlock = Extract<ContentBlock, { type: "_user_images" }>;

const FIXTURE = join(import.meta.dirname, "fixtures/cursor-session.jsonl");
const TOOL_FIXTURE_1 = join(import.meta.dirname, "fixtures/cursor-tool-1.txt");
const TOOL_FIXTURE_2 = join(import.meta.dirname, "fixtures/cursor-tool-2.txt");
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8B6v8AAAAASUVORK5CYII=";

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
    const text = (firstUser.blocks[0] as TextBlock).text;
    expect(text).not.toContain("<user_query>");
    expect(text).not.toContain("</user_query>");
    expect(text).toBe("Fix the login bug in auth.ts");
  });

  it("strips Cursor timestamp wrappers from user prompts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-timestamp-"));
    const jsonlPath = join(tempDir, "timestamp-session.jsonl");
    await writeFile(
      jsonlPath,
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: [
                "<timestamp>Tuesday, Apr 28, 2026, 4:43 PM (UTC-7)</timestamp>",
                "<user_query>",
                "Replay this Cursor session",
                "</user_query>",
              ].join("\n"),
            },
          ],
        },
      }),
      "utf-8",
    );

    try {
      const result = await parseCursorSession(jsonlPath);
      const firstUser = result.turns.find((t) => t.role === "user")!;
      expect((firstUser.blocks[0] as TextBlock).text).toBe("Replay this Cursor session");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves non-leading <timestamp> markup inside user prompts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-timestamp-inline-"));
    const jsonlPath = join(tempDir, "timestamp-inline-session.jsonl");
    const userBody = [
      "<user_query>",
      "Why is `<timestamp>2026-04-28</timestamp>` valid XML in our schema?",
      "</user_query>",
    ].join("\n");
    await writeFile(
      jsonlPath,
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: userBody }] },
      }),
      "utf-8",
    );

    try {
      const result = await parseCursorSession(jsonlPath);
      const firstUser = result.turns.find((t) => t.role === "user")!;
      expect((firstUser.blocks[0] as TextBlock).text).toBe(
        "Why is `<timestamp>2026-04-28</timestamp>` valid XML in our schema?",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts <image_files> into _user_images and removes image markers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-images-"));
    const imagePath = join(tempDir, "shot.png");
    const jsonlPath = join(tempDir, "image-session.jsonl");
    await writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
    await writeFile(
      jsonlPath,
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `<user_query>\n[Image]\nPlease investigate this bug\n<image_files>\n1. ${imagePath}\n</image_files>\n</user_query>`,
            },
          ],
        },
      }),
      "utf-8",
    );

    try {
      const result = await parseCursorSession(jsonlPath);
      const firstUser = result.turns.find((t) => t.role === "user")!;
      const textBlock = firstUser.blocks.find((b): b is TextBlock => b.type === "text")!;
      const imageBlock = firstUser.blocks.find(
        (b): b is UserImagesBlock => b.type === "_user_images",
      )!;
      expect(textBlock.text).toBe("Please investigate this bug");
      expect(imageBlock).toBeTruthy();
      expect(imageBlock.images).toHaveLength(1);
      expect(imageBlock.images[0]).toMatch(/^data:image\/png;base64,/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles prompts without <user_query> wrapper", async () => {
    const result = await parseCursorSession(FIXTURE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    const third = userTurns[2];
    const text = (third.blocks[0] as TextBlock).text;
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
  it("unpaired markers become thinking, not tool calls", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");

    const types = new Set(replay.scenes.map((s) => s.type));
    expect(types).toEqual(new Set(["user-prompt", "text-response", "thinking"]));
    expect(replay.meta.stats.toolCalls).toBe(0);
    expect(replay.meta.stats.thinkingBlocks).toBe(1);
  });

  it("creates correct scene count", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");

    expect(replay.meta.stats.userPrompts).toBe(3);
    expect(replay.meta.stats.toolCalls).toBe(0);
    expect(replay.meta.stats.thinkingBlocks).toBe(1);
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

  it("uses JSONL tool_result timestamps for tool-call durations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-tool-duration-"));
    const jsonlPath = join(tempDir, "tool-duration.jsonl");
    await writeFile(
      jsonlPath,
      [
        JSON.stringify({
          role: "assistant",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "run_terminal_cmd",
                input: { command: "pnpm test" },
              },
            ],
          },
        }),
        JSON.stringify({
          role: "user",
          timestamp: "2026-01-01T00:00:02.500Z",
          message: {
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "tests passed" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const parsed = await parseCursorSession(jsonlPath);
      const replay = transformToReplay(parsed, "cursor", "~/test/project");
      const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");

      expect(toolScenes).toHaveLength(1);
      expect(toolScenes[0].durationMs).toBe(2500);
      expect(toolScenes[0].resultTokens).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("converts unpaired marker to thinking when no tool output matches", async () => {
    const parsed = await parseCursorSession(FIXTURE);
    const replay = transformToReplay(parsed, "cursor", "~/test/project");
    const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");
    expect(toolScenes.length).toBe(0);
    const thinking = replay.scenes.filter((s) => s.type === "thinking");
    expect(thinking.length).toBe(1);
    expect(thinking[0].content).toBe("Searching for auth files");
  });
});
