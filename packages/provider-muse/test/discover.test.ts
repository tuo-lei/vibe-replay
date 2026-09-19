import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMuseSessions } from "../src/muse/discover.js";

const originalAgentsDir = process.env.MUSE_AGENTS_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalAgentsDir === undefined) delete process.env.MUSE_AGENTS_DIR;
  else process.env.MUSE_AGENTS_DIR = originalAgentsDir;
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function headerLine(agentId: string): string {
  return JSON.stringify({
    type: "session_header",
    version: 1,
    session_id: agentId,
    agent_id: agentId,
    created_at: "2026-09-18T10:00:00Z",
  });
}

function itemLine(item: unknown, createdAt = "2026-09-18T10:01:00Z"): string {
  return JSON.stringify({ type: "item", seq: 1, source: "runtime", item, created_at: createdAt });
}

function sourcedItemLine(item: unknown, source: string): string {
  return JSON.stringify({
    type: "item",
    seq: 1,
    source,
    item,
    created_at: "2026-09-18T10:01:00Z",
  });
}

async function writeAgentSession(
  root: string,
  agentId: string,
  lines: string[],
  meta?: Record<string, unknown>,
): Promise<string> {
  const sessionsDir = join(root, agentId, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const transcriptPath = join(sessionsDir, `${agentId}.jsonl`);
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
  if (meta) {
    await writeFile(join(sessionsDir, "sessions.json"), JSON.stringify(meta), "utf-8");
  }
  return transcriptPath;
}

describe("discoverMuseSessions", () => {
  it("discovers a session and extracts prompts, tool calls, and compactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const agentId = "agent-test-1";
    await writeAgentSession(
      root,
      agentId,
      [
        headerLine(agentId),
        itemLine({ type: "message", role: "user", text: "Help me refactor this module" }),
        itemLine({ type: "message", role: "assistant", text: "Sure, looking at it now." }),
        itemLine({ type: "thinking", thinking: "The module needs better structure." }),
        itemLine({ type: "function_call", call_id: "call-1", name: "edit", arguments: "{}" }),
        itemLine({
          type: "function_call_output",
          call_id: "call-1",
          output: '{"ok":true}',
          success: true,
        }),
        itemLine({ type: "commentary_text", text: "Done, let me verify." }),
        JSON.stringify({
          type: "compaction_checkpoint",
          compaction_id: 1,
          trigger: "threshold",
          created_at: "2026-09-18T10:05:00Z",
        }),
      ],
      {
        version: 1,
        sessions: [
          {
            session_id: agentId,
            agent_id: agentId,
            updated_at: "2026-09-18T10:06:00Z",
            context_window_usage: { model_id: "ipnext/avocado-5.16-v4" },
          },
        ],
      },
    );

    const sessions = await discoverMuseSessions(root);

    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.provider).toBe("muse");
    expect(session.sessionId).toBe(agentId);
    expect(session.slug).toBe(agentId.slice(0, 8));
    expect(session.firstPrompt).toBe("Help me refactor this module");
    expect(session.prompts).toEqual(["Help me refactor this module"]);
    expect(session.promptCount).toBe(1);
    expect(session.toolCallCount).toBe(1);
    expect(session.compactionCount).toBe(1);
    expect(session.model).toBe("ipnext/avocado-5.16-v4");
    expect(session.timestamp).toBe("2026-09-18T10:06:00Z");
    expect(session.lineCount).toBeGreaterThan(0);
    expect(session.fileSize).toBeGreaterThan(0);
    expect(session.sourceFingerprint).toBeTruthy();
  });

  it("skips injected subagent-context prompts for firstPrompt but still counts them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const agentId = "agent-sub-1";
    await writeAgentSession(root, agentId, [
      headerLine(agentId),
      itemLine({
        type: "message",
        role: "user",
        text: "[Subagent Context] Parent session delegated this task with huge boilerplate",
      }),
      itemLine({ type: "message", role: "user", text: "What is the actual task?" }),
    ]);

    const sessions = await discoverMuseSessions(root);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstPrompt).toBe("What is the actual task?");
    expect(sessions[0].promptCount).toBe(2);
  });

  it("skips sessions without a session header or without prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const sessionsDir = join(root, "agent-no-header", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "agent-no-header.jsonl"),
      `${itemLine({ type: "message", role: "user", text: "Hello" })}\n`,
      "utf-8",
    );
    await writeAgentSession(root, "agent-no-prompts", [
      headerLine("agent-no-prompts"),
      itemLine({ type: "message", role: "assistant", text: "Working..." }),
    ]);

    const sessions = await discoverMuseSessions(root);
    expect(sessions).toHaveLength(0);
  });

  it("reads sessions.json for updated_at when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const agentId = "agent-meta-1";
    await writeAgentSession(
      root,
      agentId,
      [
        headerLine(agentId),
        itemLine({ type: "message", role: "user", text: "Hello" }, "2026-09-18T09:00:00Z"),
      ],
      {
        version: 1,
        sessions: [{ session_id: agentId, updated_at: "2026-09-18T12:00:00Z" }],
      },
    );

    const sessions = await discoverMuseSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].timestamp).toBe("2026-09-18T12:00:00Z");
  });

  it("returns an empty list when the agents root does not exist", async () => {
    const sessions = await discoverMuseSessions(join(tmpdir(), "vibe-muse-missing-root-xyz"));
    expect(sessions).toEqual([]);
  });

  it("keeps context-only subagent sessions instead of dropping them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const agentId = "agent-ctx-only";
    await writeAgentSession(root, agentId, [
      headerLine(agentId),
      itemLine({
        type: "message",
        role: "user",
        text: "[Subagent Context] Parent session delegated this task with huge boilerplate",
      }),
      itemLine({ type: "function_call", call_id: "c1", name: "exec", arguments: "{}" }),
    ]);

    const sessions = await discoverMuseSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].promptCount).toBe(1);
    expect(sessions[0].toolCallCount).toBe(1);
    expect(sessions[0].firstPrompt).toBe("");
  });

  it("skips runtime-injected prompts for firstPrompt but still counts them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const agentId = "agent-bg-1";
    await writeAgentSession(root, agentId, [
      headerLine(agentId),
      sourcedItemLine(
        { type: "message", role: "user", text: "## Step instructions\nDo background work" },
        "runtime.self_improvement",
      ),
      itemLine({ type: "message", role: "user", text: "What is the actual task?" }),
    ]);

    const sessions = await discoverMuseSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstPrompt).toBe("What is the actual task?");
    expect(sessions[0].promptCount).toBe(2);
  });

  it("tolerates non-object JSON lines during the discovery scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const agentId = "agent-null-line";
    await writeAgentSession(root, agentId, [
      headerLine(agentId),
      "null",
      itemLine({ type: "message", role: "user", text: "Hello after null" }),
    ]);

    const sessions = await discoverMuseSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].firstPrompt).toBe("Hello after null");
  });

  it("tolerates a non-object sessions.json index", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    const agentId = "agent-bad-meta";
    const sessionsDir = join(root, agentId, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, `${agentId}.jsonl`),
      `${headerLine(agentId)}\n${itemLine({ type: "message", role: "user", text: "Hi" })}\n`,
      "utf-8",
    );
    await writeFile(join(sessionsDir, "sessions.json"), "null", "utf-8");

    const sessions = await discoverMuseSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].model).toBeUndefined();
  });

  it("uses MUSE_AGENTS_DIR when no root is passed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-discover-"));
    tempDirs.push(root);
    process.env.MUSE_AGENTS_DIR = root;
    const agentId = "agent-env-1";
    await writeAgentSession(root, agentId, [
      headerLine(agentId),
      itemLine({ type: "message", role: "user", text: "Env var root works" }),
    ]);

    const sessions = await discoverMuseSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(agentId);
  });
});
