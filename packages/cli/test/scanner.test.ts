import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aggregateProjectInsights,
  aggregateUserInsights,
  countPendingCursorUsageIndexes,
  type SessionScanResult,
  isPartialScanResult,
  isPendingCursorUsageIndex,
  scanSession,
  scanCacheEntryKey,
} from "../src/scanner.js";

// ─── Helpers ──────────────────────────────────────────────────────

function makeLine(obj: Record<string, any>): string {
  return JSON.stringify(obj);
}

let tmpDir: string;
let fixturePath: string;
const CURSOR_FIXTURE = join(
  import.meta.dirname,
  "../../provider-cursor/test/fixtures/cursor-session.jsonl",
);
const CURSOR_TOOL_FIXTURE_1 = join(
  import.meta.dirname,
  "../../provider-cursor/test/fixtures/cursor-tool-1.txt",
);
const CURSOR_TOOL_FIXTURE_2 = join(
  import.meta.dirname,
  "../../provider-cursor/test/fixtures/cursor-tool-2.txt",
);
const COWORK_FIXTURE = join(
  import.meta.dirname,
  "../../provider-claude-code/test/fixtures/claude-cowork-audit.jsonl",
);

beforeAll(async () => {
  tmpDir = join(tmpdir(), `scanner-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  // Create a test JSONL file with various message types
  const lines = [
    // file-history-snapshot (start marker)
    makeLine({
      type: "file-history-snapshot",
      sessionId: "test-session-1",
      slug: "test-slug",
      cwd: "/Users/test/Code/my-project",
      gitBranch: "main",
      permissionMode: "default",
      entrypoint: "cli",
      snapshot: { timestamp: "2025-03-20T10:00:00Z", trackedFileBackups: {} },
    }),
    // User prompt
    makeLine({
      type: "user",
      sessionId: "test-session-1",
      slug: "test-slug",
      cwd: "/Users/test/Code/my-project",
      gitBranch: "main",
      timestamp: "2025-03-20T10:00:01Z",
      message: {
        role: "user",
        id: "msg-u1",
        content: "Help me fix the login bug in auth.ts",
      },
    }),
    // Assistant with tool_use (Edit)
    makeLine({
      type: "assistant",
      sessionId: "test-session-1",
      gitBranch: "feat/fix-auth",
      timestamp: "2025-03-20T10:00:05Z",
      message: {
        role: "assistant",
        id: "msg-a1",
        model: "claude-sonnet-4-20250514",
        content: [
          { type: "thinking", thinking: "Let me look at the auth code..." },
          { type: "text", text: "I'll fix the login bug." },
          {
            type: "tool_use",
            id: "tu-1",
            name: "Edit",
            input: {
              file_path: "/Users/test/Code/my-project/src/auth.ts",
              old_string: "foo",
              new_string: "bar",
            },
          },
          {
            type: "tool_use",
            id: "tu-2",
            name: "Read",
            input: { file_path: "/Users/test/Code/my-project/src/utils.ts" },
          },
        ],
        usage: {
          input_tokens: 5000,
          output_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 4500,
        },
      },
    }),
    // User with tool results
    makeLine({
      type: "user",
      timestamp: "2025-03-20T10:00:10Z",
      message: {
        role: "user",
        id: "msg-u2",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "Edit applied" },
          { type: "tool_result", tool_use_id: "tu-2", content: "file content..." },
        ],
      },
    }),
    // Another user prompt
    makeLine({
      type: "user",
      timestamp: "2025-03-20T10:01:00Z",
      message: {
        role: "user",
        id: "msg-u3",
        content: "Now run the tests",
      },
    }),
    // PR link
    makeLine({
      type: "pr-link",
      timestamp: "2025-03-20T10:02:00Z",
      data: {
        prNumber: 42,
        prUrl: "https://github.com/test/my-project/pull/42",
        prRepository: "test/my-project",
      },
    }),
    // System events
    makeLine({
      type: "system",
      subtype: "turn_duration",
      timestamp: "2025-03-20T10:00:10Z",
      durationMs: 9000,
    }),
    makeLine({
      type: "system",
      subtype: "compact_boundary",
      timestamp: "2025-03-20T10:01:30Z",
      compactMetadata: { trigger: "auto", preTokens: 150000 },
    }),
    makeLine({
      type: "system",
      subtype: "api_error",
      timestamp: "2025-03-20T10:01:15Z",
      error: { status: 529, error: { type: "overloaded_error" } },
    }),
    // Custom title
    makeLine({
      type: "custom-title",
      customTitle: "Fix login bug in auth module",
    }),
  ];

  fixturePath = join(tmpDir, "test-session.jsonl");
  await writeFile(fixturePath, lines.join("\n"), "utf-8");
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Scanner tests ──────────────────────────────────────────────────

describe("scanSession", () => {
  it("uses provider-scoped cache identities", () => {
    expect(scanCacheEntryKey({ provider: "claude-code", sessionId: "shared" })).not.toBe(
      scanCacheEntryKey({ provider: "cursor", sessionId: "shared" }),
    );
  });

  it.each(["no-prompts", "unreadable"] as const)(
    "does not use a metadata title as a prompt for %s sources",
    async (transcriptStatus) => {
      const result = await scanSession({
        sessionId: `metadata-${transcriptStatus}`,
        provider: "opencode",
        project: "~/test/project",
        slug: "metadata-only",
        title: "State metadata title",
        firstPrompt: "",
        transcriptStatus,
        filePaths: [],
      });

      expect(result.title).toBe("State metadata title");
      expect(result.firstPrompt).toBe("");
      expect(result.promptCount).toBe(0);
      expect(result.transcriptStatus).toBe(transcriptStatus);
    },
  );

  it("extracts session metadata correctly", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.sessionId).toBe("test-session-1");
    expect(result.provider).toBe("claude-code");
    expect(result.title).toBe("Fix login bug in auth module");
    expect(result.startTime).toBe("2025-03-20T10:00:00Z");
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  it("marks an otherwise ordinary session as usage-indexed even when it has no usage", async () => {
    const path = join(tmpDir, "usage-empty.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "user",
        timestamp: "2025-03-20T10:00:00Z",
        message: { role: "user", content: "A prompt without tool calls" },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-empty",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-empty",
      filePaths: [path],
    });

    expect(result.usageSummary).toBeUndefined();
    expect(result.usageEvents).toBeUndefined();
    expect(result.usageIndexed).toBe(true);
  });

  it("uses the rich Claude parser so compactions and tool outcomes are indexed", async () => {
    const path = join(tmpDir, "claude-rich-scan.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "user",
          sessionId: "claude-rich-scan",
          timestamp: "2025-03-20T10:00:00Z",
          message: { role: "user", content: "Inspect the auth flow" },
        }),
        makeLine({
          type: "assistant",
          sessionId: "claude-rich-scan",
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            id: "assistant-1",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 30,
            },
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "src/auth.ts" },
              },
            ],
          },
        }),
        makeLine({
          type: "user",
          sessionId: "claude-rich-scan",
          timestamp: "2025-03-20T10:00:02Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "auth source" }],
          },
        }),
        makeLine({
          type: "system",
          sessionId: "claude-rich-scan",
          timestamp: "2025-03-20T10:00:03Z",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "context_limit", preTokens: 50_000 },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "claude-rich-scan",
      provider: "claude-code",
      project: "~/test/project",
      slug: "claude-rich-scan",
      filePaths: [path],
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.usageSummary?.tools).toEqual({ Read: 1 });
    expect(result.compactionCount).toBe(1);
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 5,
      cacheReadTokens: 30,
    });
  });

  it("keeps malformed tool blocks from aborting the usage scan", async () => {
    const path = join(tmpDir, "usage-malformed-tool.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        timestamp: "2025-03-20T10:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "missing-name", input: {} }],
        },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-malformed-tool",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-malformed-tool",
      filePaths: [path],
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.usageSummary?.tools).toEqual({ Unknown: 1 });
  });

  it("indexes individual tool, MCP, and skill usage without payloads", async () => {
    const path = join(tmpDir, "usage-index.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "user",
          isMeta: true,
          timestamp: "2025-03-20T10:00:00Z",
          message: {
            role: "user",
            content: "Base directory for this skill: /Users/test/.claude/skills/replay\n",
          },
        }),
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "/secret/path.ts" },
              },
              {
                type: "tool_use",
                id: "tool-2",
                name: "mcp__github__get_pull_request",
                input: { owner: "test", repo: "app" },
              },
              {
                type: "tool_use",
                id: "tool-3",
                name: "CallMcpTool",
                input: { server: "user-slack", toolName: "slack_read_channel" },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-index",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-index",
      filePaths: [path],
    });

    // MCP calls live only under the MCP counters, never duplicated as tools.
    expect(result.usageSummary?.tools).toEqual({ Read: 1 });
    expect(result.usageSummary).toMatchObject({
      mcpServers: { github: 1, slack: 1 },
      mcpTools: {
        "github/get_pull_request": 1,
        "slack/slack_read_channel": 1,
      },
      skills: { replay: 1 },
    });
    expect(result.usageEvents).toHaveLength(4);
    expect(result.usageEvents?.find((event) => event.kind === "skill")).toMatchObject({
      status: "unknown",
      attribution: "session-metadata",
    });
    expect(JSON.stringify(result.usageEvents)).not.toContain("/secret/path.ts");
  });

  it("preserves repeated rich-provider skill activations and MCP attribution", async () => {
    const path = join(tmpDir, "usage-rich-attribution.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "user",
          isMeta: true,
          timestamp: "2025-03-20T10:00:00Z",
          message: {
            role: "user",
            content: "Base directory for this skill: /Users/test/.claude/skills/review\n",
          },
        }),
        makeLine({
          type: "user",
          isMeta: true,
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            role: "user",
            content: "Base directory for this skill: /Users/test/.claude/skills/review\n",
          },
        }),
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:02Z",
          attributionMcpServer: "sourcegraph",
          attributionMcpTool: "search",
          message: {
            role: "assistant",
            id: "rich-mcp-call",
            content: [{ type: "tool_use", id: "mcp-1", name: "tool", input: {} }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-rich-attribution",
      provider: "claude-cowork",
      project: "~/test/project",
      slug: "usage-rich-attribution",
      filePaths: [path],
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.usageSummary).toMatchObject({
      tools: {},
      mcpServers: { sourcegraph: 1 },
      mcpTools: { "sourcegraph/search": 1 },
      skills: { review: 2 },
    });
    expect(result.usageEvents?.filter((event) => event.kind === "skill")).toHaveLength(2);
  });

  it("keeps usage summaries complete while bounding retained invocation details", async () => {
    const path = join(tmpDir, "usage-events-bounded.jsonl");
    const toolUses = Array.from({ length: 120 }, (_unused, index) => ({
      type: "tool_use",
      id: `tool-${index}`,
      name: `Tool-${index}`,
      input: {},
    }));
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        timestamp: "2025-03-20T10:00:00Z",
        message: { role: "assistant", content: toolUses },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-events-bounded",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-events-bounded",
      filePaths: [path],
    });

    expect(result.usageSummary?.tools).toEqual(
      Object.fromEntries(toolUses.map((tool) => [tool.name, 1])),
    );
    expect(result.usageEvents).toHaveLength(100);
    expect(result.usageEvents?.[0]?.name).toBe("Tool-20");
    expect(result.usageEvents?.[99]?.name).toBe("Tool-119");
  });

  it("marks tool outcomes from paired tool_result blocks", async () => {
    const path = join(tmpDir, "usage-status.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "ok-1", name: "Bash", input: { command: "ls" } },
              { type: "tool_use", id: "bad-1", name: "Bash", input: { command: "nope" } },
              { type: "tool_use", id: "open-1", name: "Bash", input: { command: "sleep" } },
            ],
          },
        }),
        makeLine({
          type: "user",
          timestamp: "2025-03-20T10:00:02Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "ok-1", content: "done" },
              { type: "tool_result", tool_use_id: "bad-1", is_error: true, content: "boom" },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-status",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-status",
      filePaths: [path],
    });

    expect(result.usageSummary?.successCount).toBe(1);
    expect(result.usageSummary?.errorCount).toBe(1);
    expect(result.usageEvents?.map((event) => event.status)).toEqual([
      "success",
      "error",
      "unknown",
    ]);
  });

  it("uses Claude attribution fields when MCP names are generic", async () => {
    const path = join(tmpDir, "usage-attribution.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        attributionMcpServer: "claude-in-chrome",
        attributionMcpTool: "browser_open",
        attributionSkill: "browser-skill",
        timestamp: "2025-03-20T10:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "generic-mcp", name: "Browser", input: {} }],
        },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-attribution",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-attribution",
      filePaths: [path],
    });

    expect(result.usageSummary?.tools).toEqual({});
    expect(result.usageSummary?.mcpServers).toEqual({ "claude-in-chrome": 1 });
    expect(result.usageSummary?.mcpTools).toEqual({ "claude-in-chrome/browser_open": 1 });
    expect(result.usageSummary?.skills).toEqual({});
    expect(result.skillsUsed).toEqual(["browser-skill"]);
  });

  it("does not count repeated streamed attributionSkill records as activations", async () => {
    const path = join(tmpDir, "usage-repeated-attribution-skill.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "assistant",
          attributionSkill: "mcp-adaptor",
          timestamp: "2025-03-20T10:00:00Z",
          message: {
            role: "assistant",
            id: "streamed-message",
            content: [{ type: "thinking", thinking: "one" }],
          },
        }),
        makeLine({
          type: "assistant",
          attributionSkill: "mcp-adaptor",
          timestamp: "2025-03-20T10:00:00Z",
          message: {
            role: "assistant",
            id: "streamed-message",
            content: [{ type: "text", text: "two" }],
          },
        }),
        makeLine({
          type: "assistant",
          attributionSkill: "mcp-adaptor",
          timestamp: "2025-03-20T10:00:00Z",
          message: {
            role: "assistant",
            id: "streamed-message",
            content: [{ type: "tool_use", id: "streamed-tool", name: "Read", input: {} }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-repeated-attribution-skill",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-repeated-attribution-skill",
      filePaths: [path],
    });

    expect(result.skillsUsed).toEqual(["mcp-adaptor"]);
    expect(result.usageSummary?.skills).toEqual({});
    expect(result.usageEvents?.filter((event) => event.kind === "skill")).toHaveLength(0);
    expect(result.usageSummary?.tools).toEqual({ Read: 1 });
  });

  it("normalizes placeholder MCP server names to Unknown", async () => {
    const path = join(tmpDir, "usage-unknown-mcp.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        attributionMcpServer: "-",
        attributionMcpTool: "search",
        timestamp: "2025-03-20T10:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "unknown-mcp", name: "Browser", input: {} }],
        },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-unknown-mcp",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-unknown-mcp",
      filePaths: [path],
    });

    expect(result.usageSummary?.mcpServers).toEqual({ Unknown: 1 });
    expect(result.usageSummary?.mcpTools).toEqual({ "Unknown/search": 1 });
  });

  it("resolves MCP server and tool from Cursor's dashed tool naming", async () => {
    const path = join(tmpDir, "usage-cursor-mcp.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "mcp-1",
                name: "mcp-cursor-ide-browser-browser_navigate",
                input: {},
              },
              {
                type: "tool_use",
                id: "mcp-2",
                name: "mcp-sourcegraph-search",
                input: { server: "user-sourcegraph", tool_name: "search" },
              },
              {
                // Same server, reported with the profile scope Cursor resolved it under.
                type: "tool_use",
                id: "mcp-3",
                name: "mcp-sourcegraph-search",
                input: {
                  server: "sourcegraph::mcpScope:profile:ZGVmYXVsdA:cfg:NGRkNzVmNGI",
                  tool_name: "search",
                },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-cursor-mcp",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-cursor-mcp",
      filePaths: [path],
    });

    // The `user-` prefix, the profile scope, and the plain dashed name are all
    // the same server.
    expect(result.usageSummary?.mcpTools).toMatchObject({
      "cursor-ide-browser/browser_navigate": 1,
      "sourcegraph/search": 2,
    });
    expect(result.usageSummary?.mcpServers).toMatchObject({ sourcegraph: 2 });
  });

  it("keeps MCP attribution when Cursor maps a browser tool to its replay name", async () => {
    const path = join(tmpDir, "usage-cursor-browser-mcp.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          role: "user",
          timestamp: "2025-03-20T10:00:00Z",
          message: { role: "user", content: [{ type: "text", text: "Open the page" }] },
        }),
        makeLine({
          role: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "browser-1",
                name: "mcp-cursor-ide-browser-cursor-ide-browser-browser_navigate",
                input: {
                  tools: [
                    {
                      serverName: "cursor-ide-browser",
                      name: "browser_navigate",
                      parameters: "{}",
                    },
                  ],
                },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-cursor-browser-mcp",
      provider: "cursor",
      project: "~/test/project",
      slug: "usage-cursor-browser-mcp",
      filePaths: [path],
    });

    expect(result.usageSummary?.mcpServers).toEqual({ "cursor-ide-browser": 1 });
    expect(result.usageSummary?.mcpTools).toEqual({ "cursor-ide-browser/browser_navigate": 1 });
    expect(result.usageSummary?.tools).toEqual({});
  });

  it("resolves MCP server and tool from Cursor's underscore tool naming", async () => {
    const path = join(tmpDir, "usage-cursor-mcp-underscore.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "mcp-1",
                name: "mcp_TalkToFigma_get_document_info",
                input: {},
              },
              { type: "tool_use", id: "mcp-2", name: "mcp_Sentry_whoami", input: {} },
              // MCP management tools name no server and stay plain tools.
              { type: "tool_use", id: "meta-1", name: "mcp_get_tools", input: {} },
              { type: "tool_use", id: "meta-2", name: "mcp_auth", input: {} },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-cursor-mcp-underscore",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-cursor-mcp-underscore",
      filePaths: [path],
    });

    expect(result.usageSummary?.mcpTools).toEqual({
      "TalkToFigma/get_document_info": 1,
      "Sentry/whoami": 1,
    });
    expect(result.usageSummary?.tools).toEqual({ mcp_get_tools: 1, mcp_auth: 1 });
  });

  it("resolves uppercase Cursor MCP gateway names", async () => {
    const path = join(tmpDir, "usage-cursor-uppercase-mcp.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        timestamp: "2025-03-20T10:00:01Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "mcp-docker-1",
              name: "MCP_DOCKER-browser_navigate",
              input: {},
            },
            {
              type: "tool_use",
              id: "mcp-docker-2",
              name: "MCP_DOCKER-browser_resize",
              input: {},
            },
          ],
        },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-cursor-uppercase-mcp",
      provider: "cursor",
      project: "~/test/project",
      slug: "usage-cursor-uppercase-mcp",
      filePaths: [path],
    });

    expect(result.usageSummary?.mcpServers).toEqual({ MCP_DOCKER: 2 });
    expect(result.usageSummary?.mcpTools).toEqual({
      "MCP_DOCKER/browser_navigate": 1,
      "MCP_DOCKER/browser_resize": 1,
    });
    expect(result.usageSummary?.tools).toEqual({});
  });

  it("keeps generic MCP entrypoints in the MCP facet when payloads are opaque", async () => {
    const path = join(tmpDir, "usage-generic-mcp.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        timestamp: "2025-03-20T10:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "mcp-opaque", name: "mcp", input: {} }],
        },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-generic-mcp",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-generic-mcp",
      filePaths: [path],
    });

    expect(result.usageSummary?.mcpServers).toEqual({ Unknown: 1 });
    expect(result.usageSummary?.mcpTools).toEqual({});
    expect(result.usageSummary?.tools).toEqual({});
  });

  it("resolves MCP server and tool from Pi's single-entrypoint mcp tool naming", async () => {
    const path = join(tmpDir, "usage-pi-mcp.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "mcp-1",
                name: "mcp",
                input: { search: "code search", server: "sourcegraph", limit: 10 },
              },
              {
                type: "tool_use",
                id: "mcp-2",
                name: "mcp",
                input: { tool: "slack_slack_read_thread", args: { channel_id: "C1" } },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "usage-pi-mcp",
      provider: "claude-code",
      project: "~/test/project",
      slug: "usage-pi-mcp",
      filePaths: [path],
    });

    expect(result.usageSummary?.mcpServers).toMatchObject({ sourcegraph: 1, slack: 1 });
    expect(result.usageSummary?.mcpTools).toMatchObject({ "slack/slack_read_thread": 1 });
  });

  it("identifies persisted Cursor results that still need usage indexing", () => {
    expect(
      isPendingCursorUsageIndex({
        provider: "cursor",
        usageIndexed: false,
      }),
    ).toBe(true);
    expect(
      isPendingCursorUsageIndex({
        provider: "cursor",
        usageIndexed: false,
        transcriptStatus: "unreadable",
      }),
    ).toBe(false);
    expect(
      isPendingCursorUsageIndex({
        provider: "cursor",
        usageIndexed: false,
        transcriptStatus: "no-prompts",
      }),
    ).toBe(true);
    expect(
      countPendingCursorUsageIndexes([
        { provider: "cursor", usageIndexed: false },
        { provider: "cursor", usageIndexed: true },
        { provider: "pi", usageIndexed: false },
      ]),
    ).toBe(1);
  });

  it("counts prompts correctly (excludes tool_result-only turns)", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    // 2 user prompts: "Help me fix..." and "Now run the tests"
    // The tool_result-only message should NOT be counted
    expect(result.promptCount).toBe(2);
  });

  it("excludes Claude system wrappers and tool-originated text while keeping short prompts", async () => {
    const path = join(tmpDir, "claude-prompt-filtering.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "user",
          message: {
            role: "user",
            content: "<local-command-caveat>ignore me</local-command-caveat>",
          },
        }),
        makeLine({
          type: "user",
          isCompactSummary: true,
          message: {
            role: "user",
            content: "This session is being continued from a previous conversation summary",
          },
        }),
        makeLine({
          type: "user",
          sourceToolUseID: "tool-1",
          message: { role: "user", content: [{ type: "text", text: "automated result" }] },
        }),
        makeLine({
          type: "user",
          parent_tool_use_id: "tool-2",
          message: { role: "user", content: "automated string result" },
        }),
        makeLine({ type: "user", message: { role: "user", content: "Fix it" } }),
        makeLine({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "image", source: { type: "base64", data: "abc" } }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "prompt-filtering",
      provider: "claude-code",
      project: "~/test/project",
      slug: "prompt-filtering",
      filePaths: [path],
    });
    expect(result.promptCount).toBe(2);
  });

  it("uses the Cowork parser so replay duplicates do not inflate prompt analytics", async () => {
    const result = await scanSession({
      sessionId: "cowork-session-002",
      provider: "claude-cowork",
      project: "Cowork",
      slug: "cowork-s",
      filePaths: [COWORK_FIXTURE],
      timestamp: "2025-06-15T09:00:00.000Z",
      title: "Cowork fixture",
      firstPrompt: "Please investigate Cowork storage",
      discoveryModel: "claude-opus-4-6",
    });
    expect(result.promptCount).toBe(1);
    expect(result.toolCallCount).toBe(1);
  });

  it("uses provider-reported Cowork cost in scan results", async () => {
    const path = join(tmpDir, "cowork-reported-cost.jsonl");
    await writeFile(
      path,
      [
        {
          type: "user",
          uuid: "cowork-cost-user",
          session_id: "cowork-reported-cost",
          _audit_timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "Calculate this session cost" },
        },
        {
          type: "result",
          subtype: "success",
          uuid: "cowork-cost-run",
          session_id: "cowork-reported-cost",
          _audit_timestamp: "2026-01-01T00:00:06.000Z",
          total_cost_usd: 0.35,
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "cowork-reported-cost",
      provider: "claude-cowork",
      project: "Cowork",
      slug: "cowork-reported-cost",
      filePaths: [path],
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(result.costEstimate).toBe(0.35);
  });

  it("counts tool calls and edits", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.toolCallCount).toBe(2); // Edit + Read
    expect(result.editCount).toBe(1); // Only Edit
    // The path starts with /Users/test/ which won't match homedir(), so it stays absolute
    expect(result.filesModified).toContainEqual({
      file: "/Users/test/Code/my-project/src/auth.ts",
      count: 1,
    });
  });

  it("extracts git branch history", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    // Branch switched from main → feat/fix-auth
    expect(result.gitBranch).toBe("feat/fix-auth");
    expect(result.gitBranches).toEqual(["main", "feat/fix-auth"]);
  });

  it("extracts PR links", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.prLinks).toHaveLength(1);
    expect(result.prLinks![0].prNumber).toBe(42);
  });

  it("extracts system events (compactions, API errors, duration)", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.compactionCount).toBe(1);
    expect(result.apiErrorCount).toBe(1);
    expect(result.durationMs).toBe(9000);
  });

  it("extends endTime when active duration outlasts the final event timestamp", async () => {
    const path = join(tmpDir, "duration-after-final-event.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "user",
          timestamp: "2025-03-20T10:00:00.000Z",
          message: { role: "user", content: "Run a timed task" },
        }),
        makeLine({
          type: "system",
          subtype: "turn_duration",
          timestamp: "2025-03-20T10:00:01.000Z",
          durationMs: 10_000,
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "duration-after-final-event",
      provider: "claude-code",
      project: "~/project",
      slug: "duration-after-final-event",
      filePaths: [path],
    });

    expect(result.startTime).toBe("2025-03-20T10:00:00.000Z");
    expect(result.durationMs).toBe(10_000);
    expect(result.endTime).toBe("2025-03-20T10:00:10.000Z");
  });

  it("counts synthetic assistant API error messages", async () => {
    const path = join(tmpDir, "api-error-message.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:00Z",
          isApiErrorMessage: true,
          message: {
            role: "assistant",
            id: "msg-api-error",
            content: [{ type: "text", text: "API Error: Claude's response failed." }],
          },
        }),
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          isApiErrorMessage: false,
          message: {
            role: "assistant",
            id: "msg-no-response",
            content: [{ type: "text", text: "No response requested." }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "test-session-api-error-message",
      provider: "claude-code",
      project: "~/project",
      slug: "api-error-message",
      filePaths: [path],
    });

    expect(result.apiErrorCount).toBe(1);
  });

  it("extracts token usage and cost", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.inputTokens).toBe(5000);
    expect(result.tokenUsage!.outputTokens).toBe(1000);
    expect(result.costEstimate).toBeGreaterThan(0);
  });

  it("keeps tokens but omits fabricated cost for an unknown model", async () => {
    const path = join(tmpDir, "unknown-model-session.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        timestamp: "2025-03-20T10:00:05Z",
        message: {
          role: "assistant",
          id: "unknown-model-message",
          model: "local-model",
          content: [{ type: "text", text: "Done" }],
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "unknown-model-session",
      provider: "claude-code",
      project: "~/project",
      slug: "unknown-model",
      filePaths: [path],
    });

    expect(result.tokenUsage?.inputTokens).toBe(1000);
    expect(result.costEstimate).toBeUndefined();
    expect(result.dataQualityNotes).toContain(
      "Cost estimate is unavailable because model pricing or attribution is unknown.",
    );
  });

  it("extracts entrypoint and permissionMode", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.entrypoint).toBe("cli");
    expect(result.permissionMode).toBe("default");
  });

  it("counts Delete tool calls as modified files", async () => {
    const deleteFixturePath = join(tmpDir, "delete-session.jsonl");
    await writeFile(
      deleteFixturePath,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:05Z",
          message: {
            role: "assistant",
            id: "msg-a-delete",
            content: [
              {
                type: "tool_use",
                id: "tu-delete",
                name: "Delete",
                input: {
                  file_path: "/Users/test/Code/my-project/src/obsolete.ts",
                },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "delete-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "delete-session",
      filePaths: [deleteFixturePath],
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.editCount).toBe(1);
    expect(result.filesModified).toContainEqual({
      file: "/Users/test/Code/my-project/src/obsolete.ts",
      count: 1,
    });
  });

  it("uses the Cursor parser so tool-backed sessions contribute to stats", async () => {
    const result = await scanSession({
      sessionId: "cursor-session",
      provider: "cursor",
      project: "~/test/project",
      slug: "cursor-s",
      filePaths: [CURSOR_FIXTURE],
      toolPaths: [CURSOR_TOOL_FIXTURE_1, CURSOR_TOOL_FIXTURE_2],
      timestamp: "2026-03-20T10:00:00.000Z",
    });

    expect(result.promptCount).toBe(3);
    expect(result.toolCallCount).toBe(2);
    expect(result.startTime).toBe("2026-03-20T10:00:00.000Z");
    expect(result.filesModified).toEqual([]);
  });

  it("excludes Codex developer context injections from prompt analytics", async () => {
    const codexFixturePath = join(tmpDir, "codex-context-session.jsonl");
    await writeFile(
      codexFixturePath,
      [
        makeLine({
          timestamp: "2026-04-26T10:30:00.000Z",
          type: "session_meta",
          payload: { id: "codex-context-session", cwd: "/Users/test/project", source: "cli" },
        }),
        makeLine({
          timestamp: "2026-04-26T10:30:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Use the repo testing instructions." }],
          },
        }),
        makeLine({
          timestamp: "2026-04-26T10:30:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Run the tests." },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "codex-context-session",
      provider: "codex",
      project: "~/test/project",
      slug: "codex-context",
      filePaths: [codexFixturePath],
      timestamp: "2026-04-26T10:30:00.000Z",
    });

    expect(result.promptCount).toBe(1);
    expect(result.firstPrompt).toBe("Run the tests.");
  });

  it("defers rich Cursor SQLite parsing for background scans", async () => {
    const result = await scanSession({
      sessionId: "cursor-sqlite-session",
      provider: "cursor",
      project: "~/test/project",
      slug: "cursor-sqlite",
      filePaths: [join(tmpDir, "missing-cursor-transcript.jsonl")],
      sourceFilePath:
        "/Users/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb#composerData:cursor-sqlite-session",
      sourceFileSize: 2048,
      sourceLineCount: 9,
      hasSqlite: true,
      deferRichCursorParse: true,
      timestamp: "2026-03-20T10:00:00.000Z",
      title: "Cursor SQLite session",
      firstPrompt: "Build the dashboard.",
    });

    expect(result.promptCount).toBe(5);
    expect(result.toolCallCount).toBe(0);
    expect(result.dataSource).toBe("global-state");
    expect(result.dataQualityNotes?.[0]).toContain("deferred");
  });

  it("defers Cursor SDK enrichment during the fast background scan", async () => {
    const result = await scanSession({
      sessionId: "agent-sdk-session",
      provider: "cursor",
      project: "~/test/project",
      slug: "agent-sdk",
      filePaths: [join(tmpDir, "missing-sdk-transcript.jsonl")],
      hasSqlite: false,
      hasSdk: true,
      deferRichCursorParse: true,
      timestamp: "2026-03-20T10:00:00.000Z",
      firstPrompt: "Build the dashboard.",
      discoveryPromptCount: 2,
      discoveryToolCallCount: 4,
    });

    expect(result).toMatchObject({
      dataSource: "jsonl",
      promptCount: 2,
      toolCallCount: 4,
      usageIndexed: false,
    });
    expect(result.dataQualityNotes?.[0]).toContain("deferred");
  });

  it("does not retain Cursor discovery prompt counts for unavailable transcripts", async () => {
    const result = await scanSession({
      sessionId: "cursor-unavailable",
      provider: "cursor",
      project: "~/test/project",
      slug: "cursor-unavailable",
      filePaths: [],
      hasSqlite: true,
      deferRichCursorParse: true,
      transcriptStatus: "unreadable",
      discoveryPromptCount: 12,
      firstPrompt: "",
    });

    expect(result.promptCount).toBe(0);
    expect(result.transcriptStatus).toBe("unreadable");
  });

  it("preserves Cursor discovery summaries while rich parsing is deferred", async () => {
    const result = await scanSession({
      sessionId: "cursor-discovery-summary",
      provider: "cursor",
      project: "~/test/project",
      slug: "cursor-summary",
      filePaths: [],
      sourceFilePath: "/tmp/state.vscdb#composerData:cursor-discovery-summary",
      hasSqlite: true,
      deferRichCursorParse: true,
      timestamp: "2026-03-20T10:00:00.000Z",
      firstPrompt: "Build the dashboard.",
      discoveryPromptCount: 3,
      discoveryToolCallCount: 8,
      discoveryEditCount: 2,
      discoveryModel: "gpt-5.4",
      discoveryDurationMs: 42_000,
      discoveryTokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 10,
      },
      discoveryCostEstimate: 0.01,
    });

    expect(result).toMatchObject({
      promptCount: 3,
      toolCallCount: 8,
      editCount: 2,
      model: "gpt-5.4",
      durationMs: 42_000,
      costEstimate: 0.01,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 10,
      },
    });
  });

  it("preserves discovery compaction counts in lightweight SQLite scans", async () => {
    const result = await scanSession({
      sessionId: "opencode-compacted",
      provider: "opencode",
      project: "~/test/project",
      slug: "opencode-compacted",
      filePaths: [],
      hasSqlite: true,
      timestamp: "2026-03-20T10:00:00.000Z",
      firstPrompt: "Continue after compaction.",
      discoveryCompactionCount: 2,
    });

    expect(result.compactionCount).toBe(2);
  });

  it("marks Pi rich-parser fallback as partial and preserves discovery counts", async () => {
    const missingPath = join(tmpDir, "missing-pi-session.jsonl");
    const result = await scanSession({
      sessionId: "pi-fallback-session",
      provider: "pi",
      project: "~/test/project",
      slug: "pi-fallback",
      filePaths: [missingPath],
      sourceFilePath: missingPath,
      discoveryPromptCount: 7,
      discoveryToolCallCount: 19,
      discoveryEditCount: 4,
      discoveryModel: "roblox-llm",
      discoveryDurationMs: 12_000,
    });

    expect(result.promptCount).toBe(7);
    expect(result.toolCallCount).toBe(19);
    expect(result.editCount).toBe(4);
    expect(result.model).toBe("roblox-llm");
    expect(result.durationMs).toBe(12_000);
    expect(result.dataQualityNotes).toContain(
      "Partial Pi scan: the rich parser failed, so available generic and discovery metadata was used.",
    );
  });

  it("normalizes parsed duration from the discovery start fallback", async () => {
    const path = join(tmpDir, "codex-duration-without-timestamps.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "session_meta",
          payload: { id: "codex-duration-fallback", cwd: "/tmp/project" },
        }),
        makeLine({
          type: "event_msg",
          payload: { type: "user_message", message: "Run the task" },
        }),
        makeLine({
          type: "event_msg",
          payload: { type: "task_complete", duration_ms: 15_000 },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "codex-duration-fallback",
      provider: "codex",
      project: "~/project",
      slug: "codex-duration-fallback",
      filePaths: [path],
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(result.startTime).toBe("2026-01-01T00:00:00.000Z");
    expect(result.durationMs).toBe(15_000);
    expect(result.endTime).toBe("2026-01-01T00:00:15.000Z");
  });

  it("recognizes multi-word provider names in partial scan notes", () => {
    expect(
      isPartialScanResult({
        dataQualityNotes: ["Partial Claude Cowork scan: rich parsing failed."],
      }),
    ).toBe(true);
    expect(
      isPartialScanResult({
        dataQualityNotes: ["Cursor scan completed successfully."],
      }),
    ).toBe(false);
  });
});

// ─── Aggregation tests ──────────────────────────────────────────────

describe("aggregateProjectInsights", () => {
  const scans: SessionScanResult[] = [
    {
      sessionId: "s1",
      provider: "claude-code",
      project: "~/Code/proj-a",
      slug: "slug-1",
      startTime: "2025-03-18T10:00:00Z",
      durationMs: 60000,
      model: "claude-sonnet-4-20250514",
      promptCount: 10,
      toolCallCount: 20,
      editCount: 5,
      filesModified: [
        { file: "src/a.ts", count: 2 },
        { file: "src/b.ts", count: 3 },
      ],
      costEstimate: 1.5,
      subAgentCount: 2,
      apiErrorCount: 1,
      compactionCount: 0,
      gitBranch: "feat/auth",
      gitBranches: ["main", "feat/auth"],
      prLinks: [{ prNumber: 1, prUrl: "https://github.com/t/p/pull/1", prRepository: "t/p" }],
    },
    {
      sessionId: "s2",
      provider: "claude-code",
      project: "~/Code/proj-a",
      slug: "slug-2",
      startTime: "2025-03-19T10:00:00Z",
      durationMs: 30000,
      model: "claude-sonnet-4-20250514",
      promptCount: 5,
      toolCallCount: 10,
      editCount: 3,
      filesModified: [
        { file: "src/a.ts", count: 1 },
        { file: "src/c.ts", count: 2 },
      ],
      costEstimate: 0.8,
      subAgentCount: 0,
      apiErrorCount: 0,
      compactionCount: 1,
      gitBranch: "feat/auth",
    },
    {
      sessionId: "s3",
      provider: "claude-code",
      project: "~/Code/proj-b",
      slug: "slug-3",
      startTime: "2025-03-20T10:00:00Z",
      durationMs: 45000,
      model: "claude-opus-4-20250514",
      promptCount: 8,
      toolCallCount: 15,
      editCount: 4,
      filesModified: [{ file: "src/x.ts", count: 4 }],
      costEstimate: 5.0,
      subAgentCount: 1,
      apiErrorCount: 0,
      compactionCount: 0,
      gitBranch: "main",
    },
  ];

  it("aggregates stats for a specific project", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    expect(insights.sessionCount).toBe(2);
    expect(insights.totalPrompts).toBe(15);
    expect(insights.totalToolCalls).toBe(30);
    expect(insights.totalEdits).toBe(8);
    expect(insights.totalCost).toBeCloseTo(2.3);
    expect(insights.totalDurationMs).toBe(90000);
    expect(insights.subAgentTotal).toBe(2);
    expect(insights.apiErrorTotal).toBe(1);
  });

  it("aggregates sessions from collapsed workspaces under their parent project", () => {
    const worktreeScan = {
      ...scans[0],
      sessionId: "worktree-session",
      project: "~/Code/proj-a/.claude/worktrees/feature",
    };
    const runWorkspaceScan = {
      ...scans[0],
      sessionId: "run-session",
      project: "/tmp/review-abcdef123456",
    };

    expect(aggregateProjectInsights("~/Code/proj-a", [worktreeScan]).sessionCount).toBe(1);
    expect(aggregateProjectInsights("/tmp", [runWorkspaceScan]).sessionCount).toBe(1);
  });

  it("groups branches with session IDs", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    const authBranch = insights.branches.find((b) => b.branch === "feat/auth");
    expect(authBranch).toBeDefined();
    expect(authBranch!.sessionIds).toContain("s1");
    expect(authBranch!.sessionIds).toContain("s2");
    expect(authBranch!.prLinks).toHaveLength(1);
  });

  it("identifies hot files across sessions", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    const aFile = insights.hotFiles.find((f) => f.file === "src/a.ts");
    expect(aFile).toBeDefined();
    expect(aFile!.sessionCount).toBe(2); // Appeared in both s1 and s2
  });

  it("keeps branch and hot-file counts distinct by SSH location", () => {
    const local = {
      ...scans[0],
      sessionId: "shared-session",
      gitBranches: undefined,
      filesModified: [{ file: "src/shared.ts", count: 1 }],
      gitBranch: "shared",
    };
    const remote = {
      ...local,
      location: { kind: "ssh" as const, id: "remote-dev", label: "Remote dev" },
    };
    const insights = aggregateProjectInsights("~/Code/proj-a", [local, remote]);

    expect(insights.branches.find((branch) => branch.branch === "shared")?.sessionIds).toEqual([
      "shared-session",
      "shared-session",
    ]);
    expect(insights.hotFiles.find((file) => file.file === "src/shared.ts")?.sessionCount).toBe(2);
  });

  it("keeps project totals isolated when a location scope is selected", () => {
    const local = { ...scans[0], sessionId: "local-session" };
    const remoteA = {
      ...local,
      sessionId: "remote-a-session",
      location: { kind: "ssh" as const, id: "remote-a", label: "Remote A" },
    };
    const remoteB = {
      ...local,
      sessionId: "remote-b-session",
      location: { kind: "ssh" as const, id: "remote-b", label: "Remote B" },
    };

    expect(
      aggregateProjectInsights("~/Code/proj-a", [local, remoteA, remoteB], undefined, "local"),
    ).toMatchObject({
      sessionCount: 1,
      totalPrompts: 10,
    });
    expect(
      aggregateProjectInsights(
        "~/Code/proj-a",
        [local, remoteA, remoteB],
        undefined,
        remoteA.location,
      ),
    ).toMatchObject({
      sessionCount: 1,
      totalPrompts: 10,
      location: remoteA.location,
    });
    expect(
      aggregateProjectInsights(
        "~/Code/proj-a",
        [local, remoteA, remoteB],
        undefined,
        remoteB.location,
      ).sessionCount,
    ).toBe(1);
  });

  it("counts sessions per day", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    expect(insights.sessionsPerDay["2025-03-18"]).toBe(1);
    expect(insights.sessionsPerDay["2025-03-19"]).toBe(1);
  });
});

describe("aggregateUserInsights", () => {
  const scans: SessionScanResult[] = [
    {
      sessionId: "s1",
      provider: "claude-code",
      project: "~/Code/proj-a",
      slug: "slug-1",
      startTime: "2025-03-18T10:00:00Z",
      durationMs: 60000,
      model: "claude-sonnet-4-20250514",
      promptCount: 10,
      toolCallCount: 20,
      editCount: 5,
      filesModified: [],
      costEstimate: 1.5,
      subAgentCount: 2,
      apiErrorCount: 1,
      compactionCount: 0,
    },
    {
      sessionId: "s2",
      provider: "cursor",
      project: "~/Code/proj-b",
      slug: "slug-2",
      startTime: "2025-03-19T10:00:00Z",
      durationMs: 30000,
      model: "claude-sonnet-4-20250514",
      promptCount: 5,
      toolCallCount: 10,
      editCount: 3,
      filesModified: [],
      costEstimate: 0.8,
      subAgentCount: 0,
      apiErrorCount: 0,
      compactionCount: 1,
    },
  ];

  it("aggregates across all projects", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.totalSessions).toBe(2);
    expect(insights.totalProjects).toBe(2);
    expect(insights.totalPrompts).toBe(15);
    expect(insights.totalToolCalls).toBe(30);
    expect(insights.totalCost).toBeCloseTo(2.3);
  });

  it("tracks provider distribution", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.providers["claude-code"]).toBe(1);
    expect(insights.providers.cursor).toBe(1);
  });

  it("ranks top projects by session count", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.topProjects).toHaveLength(2);
    expect(insights.topProjects[0].sessions).toBe(1);
  });

  it("counts identical project identities separately per location", () => {
    const local = { ...scans[0], sessionId: "local-session" };
    const remoteA = {
      ...local,
      sessionId: "remote-a-session",
      location: { kind: "ssh" as const, id: "remote-a", label: "Remote A" },
    };
    const remoteB = {
      ...local,
      sessionId: "remote-b-session",
      location: { kind: "ssh" as const, id: "remote-b", label: "Remote B" },
    };
    const insights = aggregateUserInsights([local, remoteA, remoteB]);

    expect(insights.totalProjects).toBe(3);
    expect(insights.topProjects).toHaveLength(3);
    expect(insights.topProjects.filter((project) => project.location?.kind === "ssh")).toHaveLength(
      2,
    );
    expect(
      insights.topProjects.find((project) => project.location?.id === "remote-a")?.sessions,
    ).toBe(1);
  });

  it("counts SDK automation by canonical project while retaining raw session paths", () => {
    const projectIdentity = {
      key: "cursor-sdk:github-pr-review:Roblox/ros",
      kind: "cursor-sdk-automation" as const,
      isAutomated: true,
      displayName: "Automated · Roblox/ros · GitHub PR review",
      workflowId: "github-pr-review",
      repository: "Roblox/ros",
    };
    const sdkScans = [
      {
        ...scans[0],
        provider: "cursor",
        sessionId: "sdk-1",
        project:
          "~/git/roblox/cursor-sdk/repos/cursor-coworktrees/worktrees/github-pr-review-Roblox-ros-13473",
        projectIdentity: { ...projectIdentity, prNumber: 13473 },
      },
      {
        ...scans[0],
        provider: "cursor",
        sessionId: "sdk-2",
        project:
          "~/git/roblox/cursor-sdk/repos/cursor-coworktrees/worktrees/github_pr_review-Roblox-ros-14156",
        projectIdentity: { ...projectIdentity, prNumber: 14156 },
      },
    ];

    const insights = aggregateUserInsights(sdkScans);

    expect(insights.totalProjects).toBe(1);
    expect(insights.topProjects).toHaveLength(2);
    expect(insights.topProjects.map((p) => p.project)).toEqual(
      expect.arrayContaining([
        "~/git/roblox/cursor-sdk/repos/cursor-coworktrees/worktrees/github-pr-review-Roblox-ros-13473",
        "~/git/roblox/cursor-sdk/repos/cursor-coworktrees/worktrees/github_pr_review-Roblox-ros-14156",
      ]),
    );
    expect(insights.topProjects.every((p) => p.projectIdentity?.key === projectIdentity.key)).toBe(
      true,
    );
    expect(aggregateProjectInsights(projectIdentity.key, sdkScans).sessionCount).toBe(2);
  });

  it("calculates average session duration", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.avgSessionDurationMs).toBe(45000); // (60000 + 30000) / 2
  });

  it("marks Cursor aggregates as partial when metrics are missing or estimated", () => {
    const insights = aggregateUserInsights([
      {
        sessionId: "cursor-1",
        provider: "cursor",
        project: "~/Code/proj-cursor",
        slug: "cursor-1",
        startTime: "2025-03-19T10:00:00Z",
        durationMs: 30000,
        promptCount: 5,
        toolCallCount: 10,
        editCount: 1,
        filesModified: [],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        dataQualityNotes: ["Duration is estimated from session start/end timestamps."],
      },
      {
        sessionId: "cursor-2",
        provider: "cursor",
        project: "~/Code/proj-cursor",
        slug: "cursor-2",
        startTime: "2025-03-20T10:00:00Z",
        promptCount: 2,
        toolCallCount: 3,
        editCount: 0,
        filesModified: [],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
      },
    ]);

    expect(insights.dataQuality?.notes).toContain(
      "1/2 Cursor sessions use best-effort duration estimates.",
    );
    expect(insights.dataQuality?.notes).toContain(
      "1/2 Cursor sessions do not have enough timing data to compute duration.",
    );
    expect(insights.dataQuality?.notes).toContain(
      "2/2 Cursor sessions do not include token snapshots, so token and cost totals are partial.",
    );
    expect(insights.dataQuality?.notes).toContain(
      "2/2 Cursor sessions do not include per-turn stats.",
    );
  });

  it("reports when aggregate cost is only a priced lower bound", () => {
    const tokenUsage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    const insights = aggregateUserInsights([
      { ...scans[0], sessionId: "priced", tokenUsage, costEstimate: 0.01 },
      {
        ...scans[0],
        sessionId: "unknown-price",
        model: "future-model",
        tokenUsage,
        costEstimate: undefined,
      },
      {
        ...scans[0],
        sessionId: "empty-usage",
        model: "future-model",
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        costEstimate: undefined,
      },
    ]);

    expect(insights.totalCost).toBe(0.01);
    expect(insights.dataQuality?.notes).toContain(
      "1/2 sessions with token usage have unknown model pricing or attribution, so displayed cost is a partial lower bound.",
    );
  });

  it("aggregates token totals and turn duration histogram percentiles", () => {
    const insights = aggregateUserInsights([
      {
        sessionId: "s1",
        provider: "claude-code",
        project: "~/Code/proj-a",
        slug: "slug-1",
        startTime: "2025-03-18T10:00:00Z",
        durationMs: 60_000,
        promptCount: 1,
        toolCallCount: 2,
        editCount: 0,
        filesModified: [],
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheCreationTokens: 10,
        },
        turnDurations: [10_000, 45_000],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
      },
      {
        sessionId: "s2",
        provider: "claude-code",
        project: "~/Code/proj-a",
        slug: "slug-2",
        startTime: "2025-03-18T11:00:00Z",
        durationMs: 120_000,
        promptCount: 1,
        toolCallCount: 1,
        editCount: 0,
        filesModified: [],
        tokenUsage: {
          inputTokens: 300,
          outputTokens: 75,
          cacheReadTokens: 40,
          cacheCreationTokens: 25,
        },
        turnDurations: [90_000, 720_000],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
      },
    ]);

    expect(insights.tokenBreakdown).toEqual({
      input: 400,
      output: 125,
      cacheRead: 60,
      cacheCreation: 35,
    });
    expect(insights.medianTurnDurationMs).toBe(67500);
    expect(insights.turnDurationHistogram?.totalTurns).toBe(4);
    expect(insights.turnDurationHistogram?.buckets.map((bucket) => bucket.count)).toEqual([
      1, 1, 1, 0, 0, 1,
    ]);
  });
});
