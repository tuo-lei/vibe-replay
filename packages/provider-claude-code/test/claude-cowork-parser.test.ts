import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCoworkLine, parseClaudeCoworkSession } from "../src/claude-cowork/parser.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";

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

  it("reports malformed JSON through the optional callback", () => {
    let malformedCount = 0;
    expect(normalizeCoworkLine("not json", () => malformedCount++)).toBeNull();
    expect(malformedCount).toBe(1);
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

    expect(result.sessionId).toBe("cowork-session-002");
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

  it("maps MCP server UUIDs to names from the sibling metadata JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-mcp-names-"));
    const sessionDir = join(tempDir, "local_session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      `${sessionDir}.json`,
      JSON.stringify({
        sessionId: "local_session",
        remoteMcpServersConfig: [
          { uuid: "02e3e881-77ef", name: "ROS: Roblox" },
          { uuid: "no-name-server" },
        ],
      }),
      "utf-8",
    );
    const auditPath = join(sessionDir, "audit.jsonl");
    await writeFile(
      auditPath,
      JSON.stringify({
        type: "assistant",
        session_id: "session",
        _audit_timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
      "utf-8",
    );

    const result = await parseClaudeCoworkSession(auditPath);
    expect(result.mcpServerNames).toEqual({ "02e3e881-77ef": "ROS: Roblox" });

    await rm(tempDir, { recursive: true, force: true });
  });

  it("summarizes Cowork system and enabled MCP definitions without retaining content", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-context-"));
    const sessionDir = join(tempDir, "local_session");
    await mkdir(sessionDir, { recursive: true });
    const systemPrompt = "Private system prompt ✓";
    const enabledTool = {
      name: "search",
      description: "Private search description",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Private query hint" } },
      },
      enabledKey: "server-1:search",
      annotations: { readOnlyHint: true },
    };
    await writeFile(
      `${sessionDir}.json`,
      JSON.stringify({
        sessionId: "local_session",
        systemPrompt,
        enabledMcpTools: { "server-1:search": true, "server-1:write": false },
        remoteMcpServersConfig: [
          {
            uuid: "server-1",
            name: "Example",
            tools: [
              enabledTool,
              {
                name: "write",
                description: "Disabled write description",
                inputSchema: { type: "object" },
                enabledKey: "server-1:write",
              },
            ],
          },
        ],
      }),
      "utf-8",
    );
    const auditPath = join(sessionDir, "audit.jsonl");
    await writeFile(
      auditPath,
      JSON.stringify({
        type: "assistant",
        session_id: "session",
        _audit_timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
      "utf-8",
    );

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      const definition = {
        name: enabledTool.name,
        description: enabledTool.description,
        inputSchema: enabledTool.inputSchema,
      };
      expect(result.contextBreakdown).toEqual({
        source: "claude-cowork-metadata",
        scope: "session-metadata",
        components: [
          {
            id: "system-prompt",
            contentBytes: Buffer.byteLength(systemPrompt),
            itemCount: 1,
          },
          {
            id: "mcp-tool-definitions",
            contentBytes: Buffer.byteLength(JSON.stringify(definition)),
            itemCount: 1,
            availableItemCount: 2,
            descriptionBytes: Buffer.byteLength(enabledTool.description),
            schemaBytes: Buffer.byteLength(JSON.stringify(enabledTool.inputSchema)),
          },
        ],
      });
      expect(JSON.stringify(result.contextBreakdown)).not.toContain("Private");
      expect(JSON.stringify(result.contextBreakdown)).not.toContain("query hint");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips Cowork replay echo user messages when the original is present", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-replay-echo-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const prompt = "Why does Cowork show duplicate user messages?";
    const lines = [
      {
        type: "user",
        uuid: "same-user-message",
        session_id: "cowork-session",
        message: { role: "user", content: prompt },
        _audit_timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "user",
        uuid: "same-user-message",
        session_id: "cli-session",
        timestamp: "2026-01-01T00:00:01.000Z",
        isReplay: true,
        message: { role: "user", content: prompt },
      },
      {
        type: "assistant",
        session_id: "cli-session",
        message: {
          model: "claude-opus-4-6",
          id: "msg_001",
          role: "assistant",
          content: [{ type: "text", text: "Only one user prompt should be rendered." }],
        },
        _audit_timestamp: "2026-01-01T00:00:02.000Z",
      },
    ];
    await writeFile(auditPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      const userTurns = result.turns.filter((turn) => turn.role === "user");
      expect(userTurns).toHaveLength(1);
      expect(userTurns[0].blocks).toEqual([{ type: "text", text: prompt }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Cowork replay user messages when no original is present", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-replay-only-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const prompt = "This older Cowork audit only has the replayed prompt.";
    await writeFile(
      auditPath,
      `${JSON.stringify({
        type: "user",
        uuid: "replay-only-user-message",
        session_id: "cli-session",
        timestamp: "2026-01-01T00:00:01.000Z",
        isReplay: true,
        message: { role: "user", content: prompt },
      })}\n`,
    );

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      const userTurns = result.turns.filter((turn) => turn.role === "user");
      expect(userTurns).toHaveLength(1);
      expect(userTurns[0].blocks).toEqual([{ type: "text", text: prompt }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips Cowork replay echo user messages with array text content", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-replay-array-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const prompt = "The user prompt is stored as a text block array.";
    const content = [{ type: "text", text: prompt }];
    const lines = [
      {
        type: "user",
        session_id: "cowork-session",
        message: { role: "user", content },
        _audit_timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "user",
        session_id: "cli-session",
        timestamp: "2026-01-01T00:00:01.000Z",
        isReplay: true,
        message: { role: "user", content },
      },
      {
        type: "assistant",
        session_id: "cli-session",
        message: {
          model: "claude-opus-4-6",
          id: "msg_001",
          role: "assistant",
          content: [{ type: "text", text: "Array-format echo should be deduped too." }],
        },
        _audit_timestamp: "2026-01-01T00:00:02.000Z",
      },
    ];
    await writeFile(auditPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      const userTurns = result.turns.filter((turn) => turn.role === "user");
      expect(userTurns).toHaveLength(1);
      expect(userTurns[0].blocks).toEqual([{ type: "text", text: prompt }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses audit start time and metadata last activity as the end bound", async () => {
    const info: SessionInfo = {
      provider: "claude-cowork",
      sessionId: "cowork-session-002",
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
    expect(result.startTime).toBe("2025-06-15T09:00:00.000Z");
    expect(result.endTime).toBe("2025-06-15T09:03:20.000Z");
  });

  it("does not emit invalid metadata timestamps when audit timestamps are absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-time-"));
    const auditPath = join(tempDir, "audit.jsonl");
    await writeFile(
      auditPath,
      JSON.stringify({
        type: "user",
        session_id: "cowork-no-time",
        message: { role: "user", content: "Inspect the workspace" },
      }),
    );
    const info: SessionInfo = {
      provider: "claude-cowork",
      sessionId: "cowork-no-time",
      slug: "cowork-no-time",
      project: "Cowork",
      cwd: "/sessions/no-time",
      version: "",
      timestamp: "not-a-date",
      lineCount: 1,
      fileSize: 100,
      filePath: auditPath,
      filePaths: [auditPath],
      firstPrompt: "Inspect the workspace",
    };

    try {
      const result = await parseClaudeCoworkSession(auditPath, info);
      expect(result.startTime).toBeUndefined();
      expect(result.endTime).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sessionId matches what discover derives from the sibling metadata JSON", async () => {
    // Guards against the replay-linking bug: discover MUST use metadata.sessionId
    // (minus the `local_` prefix) because that's what audit.jsonl's outer-wrapper
    // records carry. If either side drifts, buildReplayMaps can't link generated
    // replays back to sources and the UI shows "+ Generate" forever.
    const { extractCoworkSessionInfo } = await import("../src/claude-cowork/discover.js");
    const { mkdir, mkdtemp, copyFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");
    const META_FIXTURE = pathJoin(__dirname, "fixtures", "claude-cowork-session.json");

    const root = await mkdtemp(pathJoin(tmpdir(), "vr-cowork-idmatch-"));
    const jsonName = "local_cowork-session-xyz.json";
    const jsonPath = pathJoin(root, jsonName);
    await copyFile(META_FIXTURE, jsonPath);
    const sessionDir = pathJoin(root, jsonName.replace(/\.json$/, ""));
    await mkdir(sessionDir, { recursive: true });
    await copyFile(AUDIT_FIXTURE, pathJoin(sessionDir, "audit.jsonl"));

    const info = await extractCoworkSessionInfo(jsonPath);
    const parsed = await parseClaudeCoworkSession(pathJoin(sessionDir, "audit.jsonl"));

    expect(info).not.toBeNull();
    expect(info?.sessionId).toBe(parsed.sessionId);
  });

  it("prefers parsed model over overlay when present in audit", async () => {
    const info: SessionInfo = {
      provider: "claude-cowork",
      sessionId: "cowork-session-002",
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

  it("bills tokens, cost and duration from Cowork run result records", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-result-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const runResult = (
      uuid: string,
      timestamp: string,
      overrides: Record<string, unknown>,
    ): Record<string, unknown> => ({
      type: "result",
      subtype: "success",
      uuid,
      session_id: "cowork-billing",
      terminal_reason: "completed",
      _audit_timestamp: timestamp,
      ...overrides,
    });
    const lines = [
      {
        type: "user",
        uuid: "u1",
        session_id: "cowork-billing",
        _audit_timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "First request" },
      },
      {
        type: "assistant",
        session_id: "cowork-billing",
        _audit_timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          id: "msg_1",
          model: "claude-opus-9",
          content: [{ type: "text", text: "Partial stream snapshot" }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      runResult("run-1", "2026-01-01T00:00:06.000Z", {
        duration_ms: 6_000,
        duration_api_ms: 4_500,
        total_cost_usd: 0.25,
        usage: {
          input_tokens: 100,
          output_tokens: 900,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 70,
        },
        modelUsage: {
          "claude-opus-9[1m]": {
            inputTokens: 100,
            outputTokens: 900,
            cacheCreationInputTokens: 30,
            cacheReadInputTokens: 70,
            costUSD: 0.25,
          },
        },
      }),
      // A repeated audit record for the same run must not be billed twice.
      runResult("run-1", "2026-01-01T00:00:06.000Z", {
        duration_ms: 6_000,
        total_cost_usd: 0.25,
        usage: {
          input_tokens: 100,
          output_tokens: 900,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 70,
        },
      }),
      {
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        error_status: 529,
        error: "overloaded upstream detail that must not be stored",
        session_id: "cowork-billing",
        _audit_timestamp: "2026-01-01T00:00:07.000Z",
      },
      runResult("run-2", "2026-01-01T00:00:12.000Z", {
        duration_ms: 4_000,
        total_cost_usd: 0.1,
        usage: {
          input_tokens: 40,
          output_tokens: 60,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
        modelUsage: {
          "claude-opus-9": {
            inputTokens: 40,
            outputTokens: 60,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 10,
            costUSD: 0.1,
            canonicalModel: "claude-opus-9",
          },
        },
      }),
    ];
    await writeFile(auditPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      expect(result.tokenUsage).toEqual({
        inputTokens: 140,
        outputTokens: 960,
        cacheCreationTokens: 30,
        cacheReadTokens: 80,
      });
      expect(result.tokenUsageByModel).toEqual({
        "claude-opus-9": {
          inputTokens: 140,
          outputTokens: 960,
          cacheCreationTokens: 30,
          cacheReadTokens: 80,
        },
      });
      expect(result.reportedCostUsd).toBeCloseTo(0.35, 10);
      expect(result.totalDurationMs).toBe(10_000);
      expect(result.apiErrors).toEqual([
        {
          timestamp: "2026-01-01T00:00:07.000Z",
          errorType: "api_retry",
          statusCode: 529,
          retryAttempt: 2,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("overloaded upstream detail");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps assistant-snapshot billing for older audits without result records", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-legacy-billing-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const lines = [
      {
        type: "user",
        uuid: "u1",
        session_id: "cowork-legacy",
        _audit_timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Legacy audit request" },
      },
      {
        type: "assistant",
        session_id: "cowork-legacy",
        _audit_timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          id: "msg_legacy",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "Legacy answer" }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 3,
          },
        },
      },
    ];
    await writeFile(auditPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      expect(result.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 1,
        cacheReadTokens: 3,
      });
      expect(result.reportedCostUsd).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not retain assistant model snapshots when result billing has no model breakdown", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-result-model-fallback-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const lines = [
      {
        type: "assistant",
        session_id: "cowork-model-fallback",
        _audit_timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-9",
          content: [{ type: "text", text: "Partial snapshot" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
      {
        type: "result",
        uuid: "run-model-fallback",
        session_id: "cowork-model-fallback",
        usage: { input_tokens: 100, output_tokens: 40 },
        total_cost_usd: 0.2,
      },
    ];
    await writeFile(auditPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      expect(result.tokenUsage).toEqual({
        inputTokens: 100,
        outputTokens: 40,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      expect(result.tokenUsageByModel).toBeUndefined();
      expect(result.reportedCostUsd).toBe(0.2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives aggregate tokens from model usage when result usage is absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-model-usage-only-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const lines = [
      {
        type: "result",
        uuid: "run-model-usage-only",
        session_id: "cowork-model-usage-only",
        modelUsage: {
          "claude-sonnet-9": {
            inputTokens: 11,
            outputTokens: 7,
            cacheCreationInputTokens: 3,
            cacheReadInputTokens: 2,
          },
        },
      },
    ];
    await writeFile(auditPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      expect(result.tokenUsage).toEqual({
        inputTokens: 11,
        outputTokens: 7,
        cacheCreationTokens: 3,
        cacheReadTokens: 2,
      });
      expect(result.tokenUsageByModel).toEqual({
        "claude-sonnet-9": {
          inputTokens: 11,
          outputTokens: 7,
          cacheCreationTokens: 3,
          cacheReadTokens: 2,
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records malformed audit JSONL lines as parse warnings", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-cowork-malformed-"));
    const auditPath = join(tempDir, "audit.jsonl");
    const validLine = JSON.stringify({
      type: "user",
      session_id: "cowork-warning-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Investigate malformed cowork data" },
    });
    await writeFile(auditPath, `${validLine}\n{not-json\n`, "utf-8");

    try {
      const result = await parseClaudeCoworkSession(auditPath);
      expect(result.turns).toHaveLength(1);
      expect(result.parseWarnings).toEqual([
        expect.objectContaining({
          kind: "malformed-json",
          count: 1,
          source: "claude-cowork audit JSONL",
          firstLine: 2,
          message: "Skipped malformed JSONL line",
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
