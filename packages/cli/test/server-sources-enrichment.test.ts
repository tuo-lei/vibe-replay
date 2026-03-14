import { describe, expect, it } from "vitest";
import { __testables } from "../src/server.js";
import type { SessionInfo } from "../src/types.js";

function makeCursorSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    provider: "cursor",
    sessionId: "cursor-session-a",
    slug: "aaaaaaaa",
    project: "~/project-a",
    cwd: "/tmp/project-a",
    version: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    lineCount: 10,
    fileSize: 1024,
    filePath: "/tmp/session-a.jsonl",
    filePaths: ["/tmp/session-a.jsonl"],
    toolPaths: ["/tmp/tool-a.txt"],
    firstPrompt: "test prompt",
    ...overrides,
  };
}

describe("sources enrichment helpers", () => {
  it("skips candidate sessions already enriched in cached sources", () => {
    const merged = [
      makeCursorSession({
        promptCount: undefined,
        toolCallCount: undefined,
      }),
    ];

    const baseSources = [
      {
        provider: "cursor",
        sessionId: "cursor-session-a",
        slug: "aaaaaaaa",
        project: "~/project-a",
        timestamp: "2026-01-01T00:00:00.000Z",
        filePaths: ["/tmp/session-a.jsonl"],
        hasSqlite: true,
        promptCount: 12,
        toolCallCount: 8,
      },
    ] as any[];

    const candidates = __testables.selectCursorEnrichmentCandidates(merged, baseSources);
    expect(candidates).toHaveLength(0);
  });

  it("selects only missing-count cursor sessions and respects recency", () => {
    const merged = [
      makeCursorSession({
        sessionId: "cursor-old",
        slug: "oldold00",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      makeCursorSession({
        sessionId: "cursor-new",
        slug: "newnew00",
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
      makeCursorSession({
        sessionId: "cursor-done",
        slug: "done0000",
        timestamp: "2026-01-03T00:00:00.000Z",
      }),
    ];

    const baseSources = [
      {
        provider: "cursor",
        sessionId: "cursor-old",
        slug: "oldold00",
        project: "~/project-a",
        timestamp: "2026-01-01T00:00:00.000Z",
        filePaths: ["/tmp/session-old.jsonl"],
        promptCount: undefined,
        toolCallCount: undefined,
      },
      {
        provider: "cursor",
        sessionId: "cursor-new",
        slug: "newnew00",
        project: "~/project-a",
        timestamp: "2026-01-02T00:00:00.000Z",
        filePaths: ["/tmp/session-new.jsonl"],
        promptCount: undefined,
        toolCallCount: undefined,
      },
      {
        provider: "cursor",
        sessionId: "cursor-done",
        slug: "done0000",
        project: "~/project-a",
        timestamp: "2026-01-03T00:00:00.000Z",
        filePaths: ["/tmp/session-done.jsonl"],
        promptCount: 4,
        toolCallCount: 2,
      },
    ] as any[];

    const candidates = __testables.selectCursorEnrichmentCandidates(merged, baseSources, 2);
    expect(candidates.map((s) => s.sessionId)).toEqual(["cursor-new", "cursor-old"]);
  });

  it("does not cross-provider match by sessionId when picking cache records", () => {
    const current = makeCursorSession({ sessionId: "shared-id", slug: "aaaaaaaa" });
    const bySessionId = new Map<string, any>([
      [
        "shared-id",
        {
          provider: "claude-code",
          sessionId: "shared-id",
          slug: "claude01",
          project: "~/project-a",
          promptCount: 999,
          toolCallCount: 999,
        },
      ],
    ]);
    const byKey = new Map<string, any>([
      [
        __testables.sourceSessionKey("cursor", "~/project-a", "aaaaaaaa"),
        {
          provider: "cursor",
          sessionId: "cursor-real",
          slug: "aaaaaaaa",
          project: "~/project-a",
          promptCount: 5,
          toolCallCount: 3,
        },
      ],
    ]);

    const picked = __testables.pickSourceRecordForSession(current, bySessionId, byKey);
    expect(picked?.provider).toBe("cursor");
    expect(picked?.promptCount).toBe(5);
  });

  it("counts prompts/tools from parsed turns with compaction exclusion", () => {
    const counts = __testables.countSessionStats([
      {
        role: "user",
        subtype: "compaction-summary",
        blocks: [{ type: "text", text: "ignored" }],
      },
      {
        role: "user",
        blocks: [{ type: "_user_images", images: ["data:image/png;base64,abc"] }],
      },
      {
        role: "assistant",
        blocks: [{ type: "tool_use" }, { type: "tool_use" }],
      },
    ] as any);

    expect(counts).toEqual({ promptCount: 1, toolCallCount: 2 });
  });
});
