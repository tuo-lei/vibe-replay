import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedTurn, SessionInfo } from "../src/types.js";

const { mockParseCursorSqlite } = vi.hoisted(() => ({
  mockParseCursorSqlite: vi.fn(),
}));

vi.mock("../src/providers/cursor/sqlite-reader.js", () => ({
  parseCursorSqlite: mockParseCursorSqlite,
}));

import {
  mergeJsonlSupplementsIntoCursorTurns,
  mergeJsonlThinkingIntoCursorTurns,
  parseCursorSession,
} from "../src/providers/cursor/parser.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8B6v8AAAAASUVORK5CYII=";

describe("mergeJsonlThinkingIntoCursorTurns", () => {
  it("prepends missing JSONL thinking into matched assistant turn", () => {
    const primaryTurns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "Fix auth bug" }] as any },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "I found the issue." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "/src/auth.ts" },
          } as any,
        ] as any,
      },
    ];
    const jsonlTurns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "Fix auth bug" }] as any },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", thinking: "Inspecting auth flow" },
          { type: "text", text: "I found the issue." },
        ] as any,
      },
    ];

    const merged = mergeJsonlThinkingIntoCursorTurns(primaryTurns, jsonlTurns);
    const assistant = merged.find((t) => t.role === "assistant")!;
    expect((assistant.blocks[0] as any).type).toBe("thinking");
    expect((assistant.blocks[0] as any).thinking).toBe("Inspecting auth flow");
    expect(assistant.blocks.some((b: any) => b.type === "tool_use")).toBe(true);
  });

  it("does not duplicate thinking already present in primary turns", () => {
    const primaryTurns: ParsedTurn[] = [
      {
        role: "assistant",
        blocks: [
          { type: "thinking", thinking: "Inspecting auth flow" },
          { type: "text", text: "Done." },
        ] as any,
      },
    ];
    const jsonlTurns: ParsedTurn[] = [
      {
        role: "assistant",
        blocks: [{ type: "thinking", thinking: "Inspecting auth flow" }] as any,
      },
    ];

    const merged = mergeJsonlThinkingIntoCursorTurns(primaryTurns, jsonlTurns);
    const thinkingBlocks = merged[0].blocks.filter((b: any) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(1);
  });

  it("appends extra assistant thinking turns when JSONL has more assistant turns", () => {
    const primaryTurns: ParsedTurn[] = [
      { role: "assistant", blocks: [{ type: "text", text: "Step 1" }] as any },
    ];
    const jsonlTurns: ParsedTurn[] = [
      { role: "assistant", blocks: [{ type: "text", text: "Step 1" }] as any },
      {
        role: "assistant",
        blocks: [{ type: "thinking", thinking: "Waiting for command output" }] as any,
      },
    ];

    const merged = mergeJsonlThinkingIntoCursorTurns(primaryTurns, jsonlTurns);
    expect(merged).toHaveLength(2);
    expect((merged[1].blocks[0] as any).type).toBe("thinking");
    expect((merged[1].blocks[0] as any).thinking).toContain("Waiting for command output");
  });
});

describe("mergeJsonlSupplementsIntoCursorTurns", () => {
  it("merges missing user images from JSONL into primary user turns", () => {
    const primaryTurns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "Investigate issue" }] as any },
      { role: "assistant", blocks: [{ type: "text", text: "I will check logs." }] as any },
    ];
    const jsonlTurns: ParsedTurn[] = [
      {
        role: "user",
        blocks: [
          { type: "text", text: "Investigate issue" },
          { type: "_user_images", images: ["data:image/png;base64,abc"] },
        ] as any,
      },
    ];

    const merged = mergeJsonlSupplementsIntoCursorTurns(primaryTurns, jsonlTurns);
    const userTurn = merged.find((t) => t.role === "user")!;
    const imageBlock = (userTurn.blocks as any[]).find((b) => b.type === "_user_images");
    expect(imageBlock).toBeTruthy();
    expect(imageBlock.images).toEqual(["data:image/png;base64,abc"]);
  });
});

describe("parseCursorSession + JSONL thinking supplement", () => {
  let tempDir: string;
  let jsonlPath: string;
  let imagePath: string;

  const baseSessionInfo: SessionInfo = {
    provider: "cursor",
    sessionId: "synthetic-session-001",
    slug: "11111111",
    project: "~/Code/synthetic",
    cwd: "/Users/test/Code/synthetic",
    version: "",
    timestamp: new Date().toISOString(),
    lineCount: 3,
    fileSize: 100,
    filePath: "",
    filePaths: [],
    workspacePath: "/Users/test/Code/synthetic",
    firstPrompt: "synthetic",
  };

  beforeEach(async () => {
    mockParseCursorSqlite.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-thinking-"));
    jsonlPath = join(tempDir, "synthetic-session.jsonl");
    imagePath = join(tempDir, "shot.png");
    await writeFile(imagePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
    const content = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `<user_query>\n[Image]\nInvestigate issue\n<image_files>\n1. ${imagePath}\n</image_files>\n</user_query>`,
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "text", text: "**Inspecting logs**" }],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "text", text: "Found root cause." }],
        },
      }),
    ].join("\n");
    await writeFile(jsonlPath, content, "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("supplements SQLite result with thinking marker from JSONL", async () => {
    mockParseCursorSqlite.mockResolvedValue({
      sessionId: baseSessionInfo.sessionId,
      slug: baseSessionInfo.slug,
      title: "Synthetic",
      cwd: baseSessionInfo.cwd,
      turns: [
        { role: "user", blocks: [{ type: "text", text: "Investigate issue" }] },
        { role: "assistant", blocks: [{ type: "text", text: "Found root cause." }] },
      ],
      dataSource: "global-state",
    });

    const result = await parseCursorSession(jsonlPath, {
      ...baseSessionInfo,
      filePath: jsonlPath,
      filePaths: [jsonlPath],
    });

    expect(result.dataSource).toBe("global-state");
    expect(mockParseCursorSqlite).toHaveBeenCalledWith(
      baseSessionInfo.workspacePath,
      baseSessionInfo.sessionId,
    );

    const assistant = result.turns.find((t) => t.role === "assistant")!;
    expect((assistant.blocks[0] as any).type).toBe("thinking");
    expect((assistant.blocks[0] as any).thinking).toBe("Inspecting logs");
    expect((assistant.blocks[1] as any).type).toBe("text");
    const user = result.turns.find((t) => t.role === "user")!;
    const userImageBlock = (user.blocks as any[]).find((b) => b.type === "_user_images");
    expect(userImageBlock).toBeTruthy();
    expect(userImageBlock.images).toHaveLength(1);
    expect(userImageBlock.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(result.dataSourceInfo?.primary).toBe("global-state");
    expect(result.dataSourceInfo?.supplements).toContain(
      "cursor/projects/agent-transcripts/*.jsonl (thinking +1, images +1)",
    );
  });

  it("returns SQLite result directly when no transcript is provided", async () => {
    mockParseCursorSqlite.mockResolvedValue({
      sessionId: baseSessionInfo.sessionId,
      slug: baseSessionInfo.slug,
      title: "Synthetic",
      cwd: baseSessionInfo.cwd,
      turns: [{ role: "assistant", blocks: [{ type: "text", text: "DB only data" }] }],
      dataSource: "sqlite",
    });

    const result = await parseCursorSession([], {
      ...baseSessionInfo,
      filePath: "",
      filePaths: [],
    });

    expect(result.dataSource).toBe("sqlite");
    expect(result.turns).toHaveLength(1);
    expect((result.turns[0].blocks[0] as any).text).toBe("DB only data");
    expect(result.dataSourceInfo).toBeUndefined();
  });
});
