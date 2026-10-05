import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it("keeps cloud publication metadata with the snapshot actually uploaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-share-publication-")),
    uploads: any[] = [],
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      uploads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `upload-${uploads.length}`,
          url: `https://vibe-replay.com/r/upload-${uploads.length}`,
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      );
    });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const api = `http://127.0.0.1:${address.port}`,
      source = join(root, "source.jsonl"),
      env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: join(root, "missing-codex"),
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      },
      run = (args: string[]) => exec(process.execPath, [cli, ...args], { env });
    await writeFile(
      source,
      [
        { type: "session_meta", payload: { id: "publication-upload", cwd: root } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fresh source task" }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const fresh = JSON.parse(
        (await run(["export", source, "--format", "json", "--stdout"])).stdout,
      ),
      saved = join(root, ".vibe-replay", fresh.meta.slug),
      authDir = join(root, ".config", "vibe-replay"),
      oldUrl = "https://vibe-replay.com/r/old-snapshot";
    await mkdir(saved, { recursive: true });
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, "auth.json"),
      JSON.stringify({
        accounts: { [api]: { token: "mock-session", user: { id: "test", name: "Test" } } },
      }),
    );
    await writeFile(
      join(saved, "replay.json"),
      JSON.stringify({
        ...fresh,
        scenes: [{ type: "user-prompt", content: "Saved snapshot task" }],
      }),
    );
    const metadata = join(saved, ".vibe-replay-cloud.json");
    await writeFile(
      metadata,
      JSON.stringify({ id: "old", url: oldUrl, expiresAt: "2099-01-01T00:00:00Z" }),
    );
    const before = await Promise.all(
        [source, join(saved, "replay.json"), metadata].map((path) => readFile(path)),
      ),
      shared = JSON.parse((await run(["share", source, "--api-url", api, "--json"])).stdout);
    expect(shared).toMatchObject({
      uploaded: true,
      mode: "cloud",
      url: "https://vibe-replay.com/r/upload-1",
    });
    expect(uploads[0].replay.scenes).toContainEqual(
      expect.objectContaining({ type: "user-prompt", content: "Fresh source task" }),
    );
    expect(
      await Promise.all(
        [source, join(saved, "replay.json"), metadata].map((path) => readFile(path)),
      ),
    ).toEqual(before);
    const oldExport = (await run(["export", saved, "--stdout"])).stdout;
    expect(oldExport).toContain("Saved snapshot task");
    expect(oldExport).toContain(oldUrl);
    expect(oldExport).not.toContain(shared.url);
    const savedShare = JSON.parse(
      (
        await run([
          "share",
          fresh.meta.sessionId,
          "--provider",
          "codex",
          "--api-url",
          api,
          "--json",
        ])
      ).stdout,
    );
    expect(savedShare).toMatchObject({
      uploaded: true,
      mode: "cloud",
      url: "https://vibe-replay.com/r/upload-2",
    });
    expect(uploads).toHaveLength(2);
    expect(uploads[1].replay.scenes).toContainEqual(
      expect.objectContaining({ type: "user-prompt", content: "Saved snapshot task" }),
    );
    expect(JSON.parse(await readFile(metadata, "utf8")).url).toBe(savedShare.url);
    expect((await run(["export", saved, "--stdout"])).stdout).toContain(savedShare.url);
    expect(await readFile(source)).toEqual(before[0]);
    expect(await readFile(join(saved, "replay.json"))).toEqual(before[1]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
