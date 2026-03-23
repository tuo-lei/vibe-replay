import { describe, expect, it, vi } from "vitest";

vi.mock("../src/providers/cursor/parser.js", () => ({
  parseCursorSession: vi.fn(),
}));

import { parseCursorSession } from "../src/providers/cursor/parser.js";
import { scanSession } from "../src/scanner.js";

const mockedParseCursorSession = vi.mocked(parseCursorSession);

describe("scanSession cursor duration", () => {
  it("does not fall back to wall-clock start/end duration for Cursor sessions", async () => {
    mockedParseCursorSession.mockResolvedValueOnce({
      sessionId: "cursor-session",
      slug: "cursor-slug",
      title: "Cursor session",
      cwd: "/repo",
      turns: [
        { role: "user", blocks: [{ type: "text", text: "hello" }] },
        { role: "assistant", blocks: [{ type: "text", text: "hi" }] },
      ],
      startTime: "2025-01-01T00:00:00.000Z",
      endTime: "2025-01-02T00:00:00.000Z",
      dataSource: "global-state",
      dataSourceInfo: {
        primary: "global-state",
        sources: ["cursor/user/globalStorage/state.vscdb"],
        notes: ["Duration is unavailable for this Cursor global-state session."],
      },
    });

    const result = await scanSession({
      sessionId: "cursor-session",
      provider: "cursor",
      project: "~/Code/project",
      slug: "cursor-slug",
      filePaths: ["/tmp/session.jsonl"],
      timestamp: "2025-01-01T00:00:00.000Z",
    });

    expect(result.startTime).toBe("2025-01-01T00:00:00.000Z");
    expect(result.endTime).toBe("2025-01-02T00:00:00.000Z");
    expect(result.durationMs).toBeUndefined();
  });

  it("does not double-count subagents when parser summary already exists", async () => {
    mockedParseCursorSession.mockResolvedValueOnce({
      sessionId: "cursor-session",
      slug: "cursor-slug",
      title: "Cursor session",
      cwd: "/repo",
      turns: [
        { role: "user", blocks: [{ type: "text", text: "delegate" }] },
        {
          role: "assistant",
          blocks: [
            {
              type: "tool_use",
              name: "Agent",
              input: { subagent_type: "explore" },
            },
          ],
        },
      ],
      subAgentSummary: [{ agentId: "agent-1", agentType: "Explore", toolCalls: 0 }],
      dataSource: "global-state",
      dataSourceInfo: {
        primary: "global-state",
        sources: ["cursor/user/globalStorage/state.vscdb"],
      },
    });

    const result = await scanSession({
      sessionId: "cursor-session",
      provider: "cursor",
      project: "~/Code/project",
      slug: "cursor-slug",
      filePaths: ["/tmp/session.jsonl"],
      timestamp: "2025-01-01T00:00:00.000Z",
    });

    expect(result.subAgentCount).toBe(1);
  });
});
