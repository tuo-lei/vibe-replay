import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  discoverCoworkFromDir,
  extractCoworkSessionInfo,
} from "../src/providers/claude-cowork/discover.js";
import { deduplicateSessionsByProvider } from "../src/providers/index.js";
import type { SessionInfo } from "../src/types.js";

const fixture = (name: string): string => join(__dirname, "fixtures", name);

const COWORK_JSON = fixture("claude-cowork-session.json");
const AUDIT_FIXTURE = fixture("claude-cowork-audit.jsonl");

/**
 * Build a Cowork layout under a temp directory:
 *   tmp/
 *     account/
 *       org/
 *         local_cowork-session-xyz789.json
 *         local_cowork-session-xyz789/
 *           audit.jsonl
 */
async function buildCoworkLayout(opts?: {
  accountId?: string;
  orgId?: string;
  skipAudit?: boolean;
  metadataPath?: string;
}): Promise<{ root: string; jsonPath: string; auditPath: string }> {
  const { copyFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "vr-cowork-"));
  const orgDir = join(root, opts?.accountId ?? "account-01", opts?.orgId ?? "org-01");
  await mkdir(orgDir, { recursive: true });

  const jsonName = "local_cowork-session-xyz789.json";
  const jsonPath = join(orgDir, jsonName);
  await copyFile(opts?.metadataPath ?? COWORK_JSON, jsonPath);

  const sessionDir = join(orgDir, jsonName.replace(/\.json$/, ""));
  await mkdir(sessionDir, { recursive: true });
  const auditPath = join(sessionDir, "audit.jsonl");
  if (!opts?.skipAudit) {
    await copyFile(AUDIT_FIXTURE, auditPath);
  }

  return { root, jsonPath, auditPath };
}

// ---------------------------------------------------------------------------
// extractCoworkSessionInfo
// ---------------------------------------------------------------------------

describe("extractCoworkSessionInfo", () => {
  it("returns SessionInfo for a Cowork metadata + audit pair", async () => {
    const { jsonPath } = await buildCoworkLayout();
    const info = await extractCoworkSessionInfo(jsonPath);

    expect(info).not.toBeNull();
    expect(info?.provider).toBe("claude-cowork");
    // sessionId must equal metadata.sessionId minus the `local_` prefix so that
    // it matches audit.jsonl's outer-wrapper `session_id` — the parser uses that
    // value, and any mismatch silently breaks replay-to-source linking.
    expect(info?.sessionId).toBe("cowork-session-002");
    expect(info?.title).toBe("Research Cowork session storage");
  });

  it("does NOT use metadata.cliSessionId as SessionInfo.sessionId", async () => {
    // cliSessionId is the inner Claude Code subprocess UUID and does not appear
    // on audit.jsonl's outer-wrapper records the parser reads first. If discover
    // returned it, buildReplayMaps would never match generated replays back to
    // sources and the UI would keep showing "+ Generate" forever.
    const { jsonPath } = await buildCoworkLayout();
    const info = await extractCoworkSessionInfo(jsonPath);

    expect(info?.sessionId).not.toBe("inner-cli-subprocess-id-distinct-from-audit");
  });

  it("strips [1m]-style suffixes from model", async () => {
    const { jsonPath } = await buildCoworkLayout();
    const info = await extractCoworkSessionInfo(jsonPath);

    expect(info?.model).toBe("claude-opus-4-6");
  });

  it("uses lastActivityAt as ISO timestamp", async () => {
    const { jsonPath } = await buildCoworkLayout();
    const info = await extractCoworkSessionInfo(jsonPath);

    expect(info?.timestamp).toBe(new Date(1750000200000).toISOString());
  });

  it("uses initialMessage as the first prompt", async () => {
    const { jsonPath } = await buildCoworkLayout();
    const info = await extractCoworkSessionInfo(jsonPath);

    expect(info?.firstPrompt).toMatch(/investigate how Cowork stores session data/);
  });

  it("returns null when audit.jsonl is missing", async () => {
    const { jsonPath } = await buildCoworkLayout({ skipAudit: true });
    const info = await extractCoworkSessionInfo(jsonPath);

    expect(info).toBeNull();
  });

  it("returns null when metadata lacks sessionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-cowork-invalid-"));
    const jsonPath = join(root, "local_invalid.json");
    await writeFile(jsonPath, JSON.stringify({ title: "no id" }));

    const info = await extractCoworkSessionInfo(jsonPath);
    expect(info).toBeNull();
  });

  it("counts user prompts and tool calls via lightweight scan", async () => {
    const { jsonPath } = await buildCoworkLayout();
    const info = await extractCoworkSessionInfo(jsonPath);

    // Fixture has 2 user messages that look like prompts (the first isReplay + the initial one),
    // and exactly 1 assistant tool_use (`mcp__workspace__bash`).
    expect(info?.toolCallCount).toBe(1);
    expect((info?.promptCount ?? 0) >= 1).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// discoverCoworkFromDir
// ---------------------------------------------------------------------------

describe("discoverCoworkFromDir", () => {
  let coworkDir: string;

  beforeAll(async () => {
    const built = await buildCoworkLayout();
    coworkDir = built.root;
  });

  it("discovers sessions from the accountId/orgId layout", async () => {
    const sessions = await discoverCoworkFromDir(coworkDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe("claude-cowork");
    expect(sessions[0].sessionId).toBe("cowork-session-002");
  });

  it("returns [] when the Cowork directory does not exist", async () => {
    const sessions = await discoverCoworkFromDir("/nonexistent/path");
    expect(sessions).toHaveLength(0);
  });

  it("skips metadata JSONs whose audit.jsonl is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-cowork-mixed-"));
    const orgDir = join(root, "acc", "org");
    await mkdir(orgDir, { recursive: true });

    // Valid session
    const { copyFile } = await import("node:fs/promises");
    await copyFile(COWORK_JSON, join(orgDir, "local_session-valid.json"));
    const validDir = join(orgDir, "local_session-valid");
    await mkdir(validDir, { recursive: true });
    await copyFile(AUDIT_FIXTURE, join(validDir, "audit.jsonl"));

    // Orphan metadata with no matching audit.jsonl
    await writeFile(
      join(orgDir, "local_session-empty.json"),
      JSON.stringify({ sessionId: "local_session-empty", title: "never ran" }),
    );

    const sessions = await discoverCoworkFromDir(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("cowork-session-002");
  });

  it("ignores non-local_*.json entries in the org directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-cowork-noise-"));
    const orgDir = join(root, "acc", "org");
    await mkdir(orgDir, { recursive: true });

    const { copyFile } = await import("node:fs/promises");
    await copyFile(COWORK_JSON, join(orgDir, "local_cowork-session-xyz789.json"));
    const validDir = join(orgDir, "local_cowork-session-xyz789");
    await mkdir(validDir, { recursive: true });
    await copyFile(AUDIT_FIXTURE, join(validDir, "audit.jsonl"));

    // Noise files Cowork also writes alongside sessions:
    await writeFile(join(orgDir, "cowork_settings.json"), "{}");
    await writeFile(join(orgDir, "cowork-gb-cache.json"), "{}");

    const sessions = await discoverCoworkFromDir(root);
    expect(sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deduplicateSessionsByProvider — Cowork priority
// ---------------------------------------------------------------------------

function makeSession(sessionId: string, provider: string): SessionInfo {
  return {
    provider,
    sessionId,
    slug: sessionId,
    project: "/test/project",
    cwd: "/test/project",
    version: "1.0.0",
    timestamp: "2025-06-15T09:00:00.000Z",
    lineCount: 10,
    fileSize: 1000,
    filePath: "/test/project/session.jsonl",
    filePaths: ["/test/project/session.jsonl"],
    firstPrompt: "test prompt",
  };
}

describe("deduplicateSessionsByProvider (cowork)", () => {
  it("prefers claude-cowork over claude-desktop for the same sessionId", () => {
    const cowork = makeSession("shared-id", "claude-cowork");
    const desktop = makeSession("shared-id", "claude-desktop");

    const result = deduplicateSessionsByProvider([desktop, cowork]);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("claude-cowork");
  });

  it("prefers claude-cowork over claude-code", () => {
    const cowork = makeSession("shared-id", "claude-cowork");
    const cli = makeSession("shared-id", "claude-code");

    const result = deduplicateSessionsByProvider([cli, cowork]);
    expect(result[0].provider).toBe("claude-cowork");
  });
});
