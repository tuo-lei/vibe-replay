import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCursorSession } from "../src/providers/cursor/parser.js";
import { transformToReplay } from "../src/transform.js";

const fixture = (name: string) => join(import.meta.dirname, `fixtures/${name}`);

/** Write a JSONL file from an array of objects. Used by multiple describe blocks. */
async function writeJsonl(dir: string, name: string, lines: object[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
  return path;
}

// ---------------------------------------------------------------------------
// Edge cases: empty content, malformed JSON, nested tags
// ---------------------------------------------------------------------------
describe("Cursor parser — edge cases", () => {
  const EDGE = fixture("cursor-edge-cases.jsonl");

  it("skips empty text blocks", async () => {
    const result = await parseCursorSession(EDGE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    // Empty text and empty <user_query> should be skipped
    for (const turn of userTurns) {
      for (const block of turn.blocks) {
        if (block.type === "text") {
          expect((block as any).text.trim()).not.toBe("");
        }
      }
    }
  });

  it("skips malformed JSON lines", async () => {
    const result = await parseCursorSession(EDGE);
    // Should not throw; "not valid json here" is skipped
    expect(result.turns.length).toBeGreaterThan(0);
  });

  it("parses real user prompts despite noise", async () => {
    const result = await parseCursorSession(EDGE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    expect(userTurns.length).toBe(2);
    expect((userTurns[0].blocks[0] as any).text).toBe("First real prompt");
    expect((userTurns[1].blocks[0] as any).text).toContain("Second prompt");
  });

  it("trailing marker becomes thinking when no tool files", async () => {
    const result = await parseCursorSession(EDGE);
    const replay = transformToReplay(result, "cursor", "~/test");
    // "Some text before the marker\n\n**Running tests**" → thinking after pairing
    const thinkingScenes = replay.scenes.filter((s) => s.type === "thinking");
    const thinkingTexts = thinkingScenes.map((s) => s.content);
    expect(thinkingTexts).toContain("Running tests");
  });

  it("single-line marker becomes thinking when no tool files", async () => {
    const result = await parseCursorSession(EDGE);
    const replay = transformToReplay(result, "cursor", "~/test");
    const thinkingScenes = replay.scenes.filter((s) => s.type === "thinking");
    const thinkingTexts = thinkingScenes.map((s) => s.content);
    expect(thinkingTexts).toContain("Single marker only");
  });

  it("preserves text body before trailing marker as text-response", async () => {
    const result = await parseCursorSession(EDGE);
    const replay = transformToReplay(result, "cursor", "~/test");
    const textScenes = replay.scenes.filter((s) => s.type === "text-response");
    const texts = textScenes.map((s) => s.content);
    expect(texts).toContain("Some text before the marker");
  });
});

// ---------------------------------------------------------------------------
// Inline-constructed fixtures for granular testing
// ---------------------------------------------------------------------------
describe("Cursor parser — inline JSONL fixtures", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-cursor-test-"));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("handles user message with direct image block (no <image_files>)", async () => {
    const path = await writeJsonl(tempDir, "direct-image.jsonl", [
      {
        role: "user",
        message: {
          content: [
            { type: "text", text: "<user_query>\nCheck this\n</user_query>" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "iVBORw0KGgoAAAA",
              },
            },
          ],
        },
      },
    ]);
    const result = await parseCursorSession(path);
    const user = result.turns.find((t) => t.role === "user")!;
    const imgBlock = (user.blocks as any[]).find((b) => b.type === "_user_images");
    expect(imgBlock).toBeDefined();
    expect(imgBlock.images[0]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("deduplicates identical user images", async () => {
    const imgData = "iVBORw0KGgoAAAA";
    const path = await writeJsonl(tempDir, "dedup-images.jsonl", [
      {
        role: "user",
        message: {
          content: [
            { type: "text", text: "<user_query>\nDuplicate test\n</user_query>" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: imgData },
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: imgData },
            },
          ],
        },
      },
    ]);
    const result = await parseCursorSession(path);
    const user = result.turns.find((t) => t.role === "user")!;
    const imgBlock = (user.blocks as any[]).find((b) => b.type === "_user_images");
    expect(imgBlock.images).toHaveLength(1);
  });

  it("strips [Image] placeholder lines", async () => {
    const path = await writeJsonl(tempDir, "image-placeholder.jsonl", [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\n[Image]\nDescribe what you see\n[Image]\n</user_query>",
            },
          ],
        },
      },
    ]);
    const result = await parseCursorSession(path);
    const user = result.turns.find((t) => t.role === "user")!;
    const text = (user.blocks[0] as any).text;
    expect(text).not.toContain("[Image]");
    expect(text).toBe("Describe what you see");
  });

  it("drops system context wrapped in user_query for JSONL user messages", async () => {
    const path = await writeJsonl(tempDir, "wrapped-system-context.jsonl", [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\n<agent_transcripts>\ninternal block\n</agent_transcripts>\n</user_query>",
            },
          ],
        },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "Ignored context." }] },
      },
    ]);

    const result = await parseCursorSession(path);
    const userTurns = result.turns.filter((turn) => turn.role === "user");
    expect(userTurns).toHaveLength(0);
  });

  it("extracts title from first user prompt limited to 80 chars", async () => {
    const longPrompt = "A".repeat(120);
    const path = await writeJsonl(tempDir, "long-title.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: longPrompt }] },
      },
    ]);
    const result = await parseCursorSession(path);
    expect(result.title).toBeDefined();
    expect(result.title!.length).toBeLessThanOrEqual(80);
  });

  it("sets dataSource to 'jsonl' when no tool files", async () => {
    const path = await writeJsonl(tempDir, "datasource.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "Hello" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "Hi there" }] },
      },
    ]);
    const result = await parseCursorSession(path);
    expect(result.dataSource).toBe("jsonl");
    expect(result.dataSourceInfo?.primary).toBe("jsonl");
  });

  it("sets dataSource to 'jsonl+tools' when tool files present", async () => {
    const jsonl = await writeJsonl(tempDir, "with-tools.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "Fix bug" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "**Applying fix**" }] },
      },
    ]);
    const toolPath = join(tempDir, "tool-output.txt");
    await writeFile(toolPath, "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n");
    const result = await parseCursorSession([jsonl, toolPath]);
    expect(result.dataSource).toBe("jsonl+tools");
    expect(result.dataSourceInfo?.sources?.length).toBeGreaterThan(0);
  });

  it("maps tool output to marker and converts extras to thinking", async () => {
    const jsonl = await writeJsonl(tempDir, "marker-pairing.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "Fix it" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "**Checking files**" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "**Another action**" }] },
      },
    ]);
    const tool1 = join(tempDir, "tool1.txt");
    await writeFile(
      tool1,
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new",
    );
    const result = await parseCursorSession([jsonl, tool1]);
    const replay = transformToReplay(result, "cursor", "~/test");
    const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");
    const thinkingScenes = replay.scenes.filter((s) => s.type === "thinking");
    // First marker pairs with tool, second becomes thinking
    expect(toolScenes).toHaveLength(1);
    expect(toolScenes[0].toolName).toBe("Diff");
    expect(thinkingScenes).toHaveLength(1);
    expect(thinkingScenes[0].content).toBe("Another action");
  });

  it("appends extra tool outputs as standalone tool-call scenes", async () => {
    const jsonl = await writeJsonl(tempDir, "extra-tools.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "Do everything" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "Working on it." }] },
      },
    ]);
    const tool1 = join(tempDir, "extra1.txt");
    const tool2 = join(tempDir, "extra2.txt");
    await writeFile(tool1, "diff --git a/a.ts b/a.ts\n");
    await writeFile(tool2, "https://example.com/api-docs");
    const result = await parseCursorSession([jsonl, tool1, tool2]);
    const replay = transformToReplay(result, "cursor", "~/test");
    const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");
    // No markers to pair → both become standalone tool calls
    expect(toolScenes).toHaveLength(2);
    expect(toolScenes[0].toolName).toBe("Diff");
    expect(toolScenes[1].toolName).toBe("WebFetch");
  });

  it("infers tool names correctly from content", async () => {
    const jsonl = await writeJsonl(tempDir, "tool-names.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "test" }] },
      },
    ]);
    const diffTool = join(tempDir, "diff-tool.txt");
    const urlTool = join(tempDir, "url-tool.txt");
    const jsonTool = join(tempDir, "json-tool.txt");
    const bashTool = join(tempDir, "bash-tool.txt");
    const otherTool = join(tempDir, "other-tool.txt");
    await writeFile(diffTool, "diff --git a/f.ts b/f.ts\n");
    await writeFile(urlTool, "https://docs.example.com/guide");
    await writeFile(jsonTool, '{"key": "value"}');
    await writeFile(bashTool, "$ npm install\nadded 50 packages");
    await writeFile(otherTool, "Some arbitrary output that does not match patterns");
    const result = await parseCursorSession([
      jsonl,
      diffTool,
      urlTool,
      jsonTool,
      bashTool,
      otherTool,
    ]);
    const replay = transformToReplay(result, "cursor", "~/test");
    const toolNames = replay.scenes.filter((s) => s.type === "tool-call").map((s) => s.toolName);
    expect(toolNames).toContain("Diff");
    expect(toolNames).toContain("WebFetch");
    expect(toolNames).toContain("API");
    expect(toolNames).toContain("Bash");
    expect(toolNames).toContain("ToolOutput");
  });
});

// ---------------------------------------------------------------------------
// Cursor → transform integration
// ---------------------------------------------------------------------------
describe("Cursor → transform — comprehensive", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-cursor-xform-"));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("redacts home directory paths in Cursor output", async () => {
    const home = homedir();
    const path = await writeJsonl(tempDir, "path-redact.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "Check config" }] },
      },
      {
        role: "assistant",
        message: {
          content: [{ type: "text", text: `Found file at ${home}/projects/secret.ts` }],
        },
      },
    ]);
    const parsed = await parseCursorSession(path);
    const replay = transformToReplay(parsed, "cursor", "~/test");
    const textScene = replay.scenes.find((s) => s.type === "text-response");
    expect(textScene?.content).toContain("~/projects/secret.ts");
    expect(textScene?.content).not.toContain(home);
  });

  it("image-only user prompt produces '(image)' content", async () => {
    const path = await writeJsonl(tempDir, "image-only.jsonl", [
      {
        role: "user",
        message: {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAA" },
            },
          ],
        },
      },
    ]);
    const parsed = await parseCursorSession(path);
    const replay = transformToReplay(parsed, "cursor", "~/test");
    const userScene = replay.scenes.find((s) => s.type === "user-prompt");
    expect(userScene).toBeDefined();
    expect(userScene?.content).toBe("(image)");
    expect((userScene as any).images).toHaveLength(1);
  });

  it("produces correct stats for mixed content", async () => {
    const jsonl = await writeJsonl(tempDir, "mixed.jsonl", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "Fix it" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "**Running lint**" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "All good now." }] },
      },
      {
        role: "user",
        message: { content: [{ type: "text", text: "Thanks" }] },
      },
    ]);
    const tool1 = join(tempDir, "lint-output.txt");
    await writeFile(tool1, "$ eslint .\n0 errors, 0 warnings");
    const parsed = await parseCursorSession([jsonl, tool1]);
    const replay = transformToReplay(parsed, "cursor", "~/test");
    expect(replay.meta.stats.userPrompts).toBe(2);
    expect(replay.meta.stats.toolCalls).toBe(1);
    expect(replay.meta.stats.sceneCount).toBe(replay.scenes.length);
  });
});

// ---------------------------------------------------------------------------
// mergeJsonlSupplementsIntoCursorTurns (exported function)
// ---------------------------------------------------------------------------
describe("Cursor — mergeJsonlSupplementsIntoCursorTurns", () => {
  it("handles empty JSONL supplement gracefully", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-merge-test-"));
    try {
      const path = join(tempDir, "empty-supplement.jsonl");
      await writeFile(path, "", "utf-8");
      const result = await parseCursorSession(path);
      expect(result.turns).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
