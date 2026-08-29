import { describe, expect, it } from "vitest";
import { createLocalAssistantTools } from "../src/local-assistant.js";
import type { ReplaySession } from "../src/types.js";

function makeReplay(): ReplaySession {
  return {
    meta: {
      sessionId: "session-1",
      slug: "fix-auth",
      title: "Fix authentication redirect",
      provider: "pi",
      startTime: "2026-05-10T10:00:00.000Z",
      endTime: "2026-05-10T10:04:00.000Z",
      cwd: "/tmp/vibe-replay-test",
      project: "~/Code/app",
      model: "test-model",
      stats: {
        sceneCount: 3,
        userPrompts: 1,
        toolCalls: 1,
        durationMs: 240_000,
        costEstimate: 0.12,
      },
      gitRepo: "example/app",
      gitBranch: "fix/auth",
      compactions: [],
    },
    scenes: [
      {
        type: "user-prompt",
        content: "Fix the authentication redirect in the login callback.",
      },
      {
        type: "tool-call",
        toolName: "read",
        input: { file_path: "src/auth.ts" },
        result: "export function callback() {}",
      },
      {
        type: "text-response",
        content: "The callback now preserves the return URL.",
      },
    ],
  };
}

function makeData(replay: ReplaySession) {
  return {
    listSources: async () => [],
    listReplays: async () => [
      {
        slug: replay.meta.slug,
        baseDir: "/tmp/vibe-replay-test",
        sessionId: replay.meta.sessionId,
        title: replay.meta.title,
        provider: replay.meta.provider,
        model: replay.meta.model,
        project: replay.meta.project,
        startTime: replay.meta.startTime,
        endTime: replay.meta.endTime,
        stats: replay.meta.stats,
        replaySize: 123,
        replayOutdated: false,
        hasAnnotations: false,
        annotationCount: 0,
      },
    ],
    getSession: async () => replay,
    getScanResults: () => [],
    getUserInsights: async () => null,
    getProjectInsights: async () => null,
  };
}

function makeRemoteData(replay: ReplaySession) {
  const data = makeData(replay);
  return {
    ...data,
    listReplays: async () => [
      {
        slug: replay.meta.slug,
        baseDir: "/tmp/vibe-replay-test",
        sessionId: replay.meta.sessionId,
        title: replay.meta.title,
        provider: replay.meta.provider,
        location: { kind: "ssh" as const, id: "remote-dev", label: "Remote dev" },
        project: replay.meta.project,
        startTime: replay.meta.startTime,
        stats: replay.meta.stats,
        replaySize: 123,
        replayOutdated: false,
        hasAnnotations: false,
        annotationCount: 0,
      },
    ],
  };
}

function makeSourceOnlyData() {
  return {
    listSources: async () => [
      {
        provider: "cursor",
        slug: "cursor-source-session",
        sessionId: "cursor-session-1",
        title: "Cursor source session",
        project: "~/Code/app",
        timestamp: "2026-05-10T10:00:00.000Z",
        fileSize: 100,
        lineCount: 4,
        firstPrompt: "Investigate the gateway",
        filePaths: [],
        existingReplay: null,
      },
    ],
    listReplays: async () => [],
    getSession: async () => {
      throw new Error("source-only session has no generated replay");
    },
    getScanResults: () => [],
    getUserInsights: async () => null,
    getProjectInsights: async () => null,
  };
}

describe("local assistant tools", () => {
  it("searches replay metadata without changing local data", async () => {
    const replay = makeReplay();
    const tools = createLocalAssistantTools(makeData(replay), { mode: "dashboard" });
    const search = tools.find((tool) => tool.name === "search_sessions");

    expect(search).toBeDefined();
    const result = await search!.execute("search-1", { query: "authentication", limit: 5 });

    expect(result.details).toMatchObject({
      toolName: "search_sessions",
      summary: "Found 1 matching local session",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"slug":"fix-auth"'),
    });
  });

  it("cites source-only sessions for the Sessions view instead of Insights", async () => {
    const tools = createLocalAssistantTools(makeSourceOnlyData(), { mode: "dashboard" });
    const search = tools.find((tool) => tool.name === "search_sessions");

    const result = await search!.execute("source-search", { query: "gateway" });

    expect(result.details).toMatchObject({
      citations: [
        {
          type: "session",
          slug: "cursor-source-session",
          provider: "cursor",
          sessionId: "cursor-session-1",
          replayAvailable: false,
        },
      ],
    });
  });

  it("returns bounded scene content and read-only navigation actions", async () => {
    const replay = makeReplay();
    const tools = createLocalAssistantTools(makeData(replay), {
      mode: "replay",
      currentSession: { slug: "fix-auth", provider: "pi", sceneIndex: 1 },
    });
    const content = tools.find((tool) => tool.name === "get_session_content");
    const scene = tools.find((tool) => tool.name === "get_scene");
    const open = tools.find((tool) => tool.name === "open_replay");

    expect(content).toBeDefined();
    expect(scene).toBeDefined();
    expect(open).toBeDefined();
    const contentResult = await content!.execute("content-1", {
      slug: "fix-auth",
      sceneStart: 1,
      sceneEnd: 2,
    });
    const sceneResult = await scene!.execute("scene-1", {
      slug: "fix-auth",
      sceneIndex: 1,
    });
    const openResult = await open!.execute("open-1", {
      slug: "fix-auth",
      sceneIndex: 1,
    });

    expect(contentResult.details).toMatchObject({
      toolName: "get_session_content",
      summary: "Read 2 replay scenes",
    });
    expect(sceneResult.details).toMatchObject({
      toolName: "get_scene",
      citations: [{ type: "scene", sceneIndex: 1 }],
    });
    expect(openResult.details).toMatchObject({
      toolName: "open_replay",
      actions: [{ type: "open_replay", slug: "fix-auth", sceneIndex: 1 }],
    });
  });

  it("keeps SSH session content behind explicit consent", async () => {
    const replay = makeReplay();
    const tools = createLocalAssistantTools(makeRemoteData(replay), { mode: "dashboard" });
    const search = tools.find((tool) => tool.name === "search_sessions");
    const summary = tools.find((tool) => tool.name === "get_session_summary");

    const searchResult = await search!.execute("remote-search", { query: "authentication" });
    expect(searchResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"total":0'),
    });
    expect(searchResult.content[0]).toMatchObject({
      text: expect.stringContaining('"remoteSessionsHidden":1'),
    });
    await expect(
      summary!.execute("remote-summary", { slug: "fix-auth", targetId: "remote-dev" }),
    ).rejects.toThrow("Enable SSH session data");
  });

  it("redacts credential-shaped content before returning tool data", async () => {
    const replay = makeReplay();
    const fakeKey = ["sk", "abcdefghijklmnopqrstuvwxyz"].join("-");
    replay.scenes.push({
      type: "text-response",
      content: `debug token ${fakeKey} and API_KEY=super-secret-value`,
    });
    const tools = createLocalAssistantTools(makeData(replay), { mode: "replay" });
    const content = tools.find((tool) => tool.name === "get_session_content");

    const result = await content!.execute("redact-1", {
      slug: "fix-auth",
      sceneStart: 3,
      sceneEnd: 3,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain(fakeKey);
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("[REDACTED]");
  });
});
