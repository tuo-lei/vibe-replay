// E2E for live mode (`/api/live` SSE endpoint)
// — boots the *real* CLI server with a temp $HOME containing a fake
//   Claude Code JSONL session, opens an SSE connection, then appends new
//   turns to the JSONL and asserts the stream delivers updated payloads.
//
// HOME is overridden BEFORE the dynamic import so the Claude Code provider's
// module-level `CLAUDE_DIR = join(homedir(), ...)` resolves to the temp dir.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface ParsedSseEvent {
  data: any;
}

/**
 * Subscribe to an SSE endpoint and yield each parsed event as it arrives.
 * Caller is responsible for cancelling via the AbortController when done.
 */
async function* readSse(
  url: string,
  signal: AbortSignal,
): AsyncGenerator<ParsedSseEvent, void, void> {
  const resp = await fetch(url, { signal, headers: { Accept: "text/event-stream" } });
  if (!resp.body) throw new Error("no body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line (\n\n)
    let sepIdx: number;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      try {
        yield { data: JSON.parse(json) };
      } catch {
        // Ignore malformed lines (e.g., keep-alive comments)
      }
    }
  }
}

describe("Live mode SSE", () => {
  const sessionId = "live-test-session-001";
  const projectPath = "/Users/test/live-project";
  const projectDirEncoded = "-Users-test-live-project";
  let tmpHome: string;
  let jsonlPath: string;
  let serverProcess: ReturnType<typeof spawn> | null = null;
  let serverPort: number | null = null;
  let browser: Browser | null = null;

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "vibe-live-test-"));
    const projectsDir = join(tmpHome, ".claude", "projects", projectDirEncoded);
    await mkdir(projectsDir, { recursive: true });
    jsonlPath = join(projectsDir, `${sessionId}.jsonl`);

    // Initial JSONL — system init + first user prompt + first assistant text
    const initialLines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        sessionId,
        slug: "live-slug",
        cwd: projectPath,
        version: "1.0.0",
        timestamp: "2026-04-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hello, please help me." },
        timestamp: "2026-04-26T10:00:01Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Sure, what do you need?" }],
        },
        timestamp: "2026-04-26T10:00:02Z",
      }),
    ];
    await writeFile(jsonlPath, `${initialLines.join("\n")}\n`, "utf-8");

    // Spawn the real CLI server with our temp HOME so Claude Code's discover()
    // points at the fixture. We use a bootstrap script that calls startServer
    // directly — the `vibe-replay` entry doesn't expose a way to skip auto-open
    // without going through `live` (which would auto-pick the wrong session).
    const bootstrap = `
      import { startServer } from "${join(import.meta.dirname, "..", "packages/cli/src/server.ts").replace(/\\\\/g, "/")}";
      const port = await new Promise(async (resolve) => {
        const baseDir = "${join(tmpHome, ".vibe-replay").replace(/\\\\/g, "/")}";
        // startServer auto-opens unless VIBE_REPLAY_NO_AUTO_OPEN=1; that's set in env
        startServer(baseDir, { openDashboard: true });
      });
    `;
    const bootstrapPath = join(tmpHome, "boot.mjs");
    await writeFile(bootstrapPath, bootstrap, "utf-8");

    serverProcess = spawn("pnpm", ["exec", "tsx", bootstrapPath], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome, // win compat (test still skipped on win)
        VIBE_REPLAY_NO_AUTO_OPEN: "1",
      },
      cwd: join(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Parse the port from server stdout: "Dashboard running at http://localhost:PORT/..."
    serverPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server start timeout")), 20_000);
      const onData = (buf: Buffer) => {
        const text = buf.toString();
        const m = text.match(/http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timeout);
          serverProcess!.stdout!.off("data", onData);
          resolve(Number(m[1]));
        }
      };
      serverProcess!.stdout!.on("data", onData);
      serverProcess!.stderr!.on("data", (b) => {
        // Surface server errors during boot for easier debugging
        process.stderr.write(b);
      });
      serverProcess!.on("exit", (code) => {
        if (serverPort === null) {
          clearTimeout(timeout);
          reject(new Error(`server exited early with code ${code}`));
        }
      });
    });

    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      // Give it a beat to clean up watchers
      await new Promise((r) => setTimeout(r, 200));
    }
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("streams an initial session and a delta after the JSONL grows", async () => {
    expect(serverPort).not.toBeNull();
    const ac = new AbortController();
    const url = `http://127.0.0.1:${serverPort}/api/live?provider=claude-code&sessionId=${encodeURIComponent(sessionId)}`;

    const events: any[] = [];
    const collect = (async () => {
      for await (const ev of readSse(url, ac.signal)) {
        if (ev.data.type === "ping") continue;
        events.push(ev.data);
        if (events.length >= 2) {
          ac.abort();
          break;
        }
      }
    })().catch((err) => {
      // Aborting causes an AbortError — that's expected once we have 2 events
      if (err?.name !== "AbortError") throw err;
    });

    // Wait for initial event
    const waitForCount = async (n: number, timeoutMs: number) => {
      const start = Date.now();
      while (events.length < n && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitForCount(1, 5_000);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("session");
    const initialScenes = events[0].session.scenes.length;
    expect(initialScenes).toBeGreaterThan(0);

    // Append a new user+assistant turn — this should trip fs.watch
    const newLines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Tell me a joke." },
        timestamp: "2026-04-26T10:01:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Why did the dev cross the road?" }],
        },
        timestamp: "2026-04-26T10:01:01Z",
      }),
    ];
    const { appendFile } = await import("node:fs/promises");
    await appendFile(jsonlPath, `${newLines.join("\n")}\n`, "utf-8");

    // Wait for delta event (debounce is 250ms so allow generous timeout)
    await waitForCount(2, 5_000);
    await collect;

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[1].type).toBe("session");
    expect(events[1].session.scenes.length).toBeGreaterThan(initialScenes);
  }, 30_000);

  it("renders the LIVE badge in the viewer and follows tail when JSONL grows", async () => {
    expect(browser).not.toBeNull();
    expect(serverPort).not.toBeNull();
    const page = await browser!.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Auth probe + favicon 404s are unrelated network noise; live mode does
      // not care about them.
      if (text.includes("Failed to load resource")) return;
      consoleErrors.push(text);
    });

    const url = `http://127.0.0.1:${serverPort}/?live=1&provider=claude-code&sessionId=${encodeURIComponent(sessionId)}`;
    // domcontentloaded — networkidle would never settle while the SSE stream
    // is held open
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // LIVE badge — green dot + "Live" label once SSE is open
    const liveBadge = page.locator("text=Live").first();
    await liveBadge.waitFor({ timeout: 10_000 });

    // Initial conversation should be visible — first user prompt content
    await page.waitForSelector("text=Hello, please help me.", { timeout: 10_000 });

    // Append a NEW user prompt; the viewer should auto-follow tail and surface
    // the new prompt without a manual refresh.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      jsonlPath,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "Tell me a fresh joke please." },
        timestamp: "2026-04-26T10:02:00Z",
      })}\n${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "A different punchline." }],
        },
        timestamp: "2026-04-26T10:02:01Z",
      })}\n`,
      "utf-8",
    );

    await page.waitForSelector("text=Tell me a fresh joke please.", { timeout: 10_000 });

    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join("\n")}`).toEqual([]);
    await page.close();
  }, 40_000);
});
