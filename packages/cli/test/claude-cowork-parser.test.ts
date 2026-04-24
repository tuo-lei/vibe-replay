import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeCoworkLine,
  parseClaudeCoworkSession,
} from "../src/providers/claude-cowork/parser.js";
import type { SessionInfo } from "../src/types.js";

const AUDIT_FIXTURE = join(__dirname, "fixtures", "claude-cowork-audit.jsonl");

describe("normalizeCoworkLine", () => {
  it("renames session_id to sessionId and drops the original", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({
        type: "user",
        session_id: "abc-123",
        message: { role: "user", content: "hi" },
      }),
    );
    const obj = JSON.parse(out!);
    expect(obj.sessionId).toBe("abc-123");
    expect("session_id" in obj).toBe(false);
  });

  it("renames parent_tool_use_id to parentToolUseID and drops the original", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "user", parent_tool_use_id: "tool-42", message: {} }),
    );
    const obj = JSON.parse(out!);
    expect(obj.parentToolUseID).toBe("tool-42");
    expect("parent_tool_use_id" in obj).toBe(false);
  });

  it("uses _audit_timestamp as a fallback when timestamp is missing", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({ type: "assistant", _audit_timestamp: "2025-06-15T10:00:00Z" }),
    );
    const obj = JSON.parse(out!);
    expect(obj.timestamp).toBe("2025-06-15T10:00:00Z");
  });

  it("keeps the existing timestamp when both are present", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({
        type: "user",
        timestamp: "2025-06-15T09:00:00Z",
        _audit_timestamp: "2025-06-15T09:00:00.500Z",
      }),
    );
    const obj = JSON.parse(out!);
    expect(obj.timestamp).toBe("2025-06-15T09:00:00Z");
  });

  it("returns null for unparseable JSON", () => {
    expect(normalizeCoworkLine("not json")).toBeNull();
    expect(normalizeCoworkLine("")).toBeNull();
  });

  it("passes through unrelated fields unchanged", () => {
    const out = normalizeCoworkLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
        session_id: "s1",
      }),
    );
    const obj = JSON.parse(out!);
    expect(obj.type).toBe("rate_limit_event");
    expect(obj.rate_limit_info.status).toBe("allowed");
  });
});

describe("parseClaudeCoworkSession", () => {
  it("parses a fixture audit.jsonl into turns", async () => {
    const result = await parseClaudeCoworkSession(AUDIT_FIXTURE);

    expect(result.sessionId).toBe("cowork-cli-session-002");
    expect(result.turns.length).toBeGreaterThan(0);
    const userTurns = result.turns.filter((t) => t.role === "user");
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    expect(userTurns.length).toBeGreaterThanOrEqual(1);
    expect(assistantTurns.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts the tool_use call from a normalized audit.jsonl", async () => {
    const result = await parseClaudeCoworkSession(AUDIT_FIXTURE);

    const assistantBlocks = result.turns.flatMap((t) => (t.role === "assistant" ? t.blocks : []));
    const toolUses = assistantBlocks.filter((b) => b.type === "tool_use");
    expect(toolUses.length).toBe(1);
    expect((toolUses[0] as { name: string }).name).toBe("mcp__workspace__bash");
  });

  it("overlays title, model, startTime from sessionInfo when missing in audit", async () => {
    const info: SessionInfo = {
      provider: "claude-cowork",
      sessionId: "cowork-cli-session-002",
      slug: "cowork-c",
      title: "Research Cowork session storage",
      project: "Cowork",
      cwd: "/sessions/foo",
      version: "",
      timestamp: "2025-06-15T09:03:20.000Z",
      lineCount: 8,
      fileSize: 1000,
      filePath: AUDIT_FIXTURE,
      filePaths: [AUDIT_FIXTURE],
      firstPrompt: "Please investigate",
      model: "claude-opus-4-6",
    };
    const result = await parseClaudeCoworkSession(AUDIT_FIXTURE, info);

    expect(result.title).toBe("Research Cowork session storage");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.startTime).toBe("2025-06-15T09:03:20.000Z");
  });

  it("prefers parsed model over overlay when present in audit", async () => {
    const info: SessionInfo = {
      provider: "claude-cowork",
      sessionId: "cowork-cli-session-002",
      slug: "cowork-c",
      project: "Cowork",
      cwd: "",
      version: "",
      timestamp: "2025-06-15T09:03:20.000Z",
      lineCount: 8,
      fileSize: 1000,
      filePath: AUDIT_FIXTURE,
      filePaths: [AUDIT_FIXTURE],
      firstPrompt: "Please investigate",
      model: "overlay-model-wins-only-when-missing",
    };
    const result = await parseClaudeCoworkSession(AUDIT_FIXTURE, info);

    // Audit has model claude-opus-4-6 on the assistant turn — parsed value must win.
    expect(result.model).toBe("claude-opus-4-6");
  });
});
