import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sessionLocationHash } from "@vibe-replay/types";
import { afterEach, describe, expect, it } from "vitest";
import { registerArchiveRoutes } from "../src/server-routes/archive.js";

const roots: string[] = [];
const originalConfig = process.env.VIBE_REPLAY_CONFIG;

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.VIBE_REPLAY_CONFIG;
  else process.env.VIBE_REPLAY_CONFIG = originalConfig;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function archiveApp(baseDir: string): Hono {
  const app = new Hono();
  registerArchiveRoutes(app, { baseDir });
  return app;
}

describe("archive target isolation", () => {
  it("keeps local and SSH archive markers separate", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-archive-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ remoteSources: [{ id: "remote-a", sshHost: "host" }] }),
      "utf-8",
    );
    process.env.VIBE_REPLAY_CONFIG = configPath;
    const app = archiveApp(root);
    const remoteMarker = `shared--ssh-${sessionLocationHash("remote-a")}`;

    await expect(
      app.request("/api/archive/shared", { method: "POST" }).then((response) => response.status),
    ).resolves.toBe(200);
    await expect(
      app
        .request("/api/archive/shared?targetId=remote-a", { method: "POST" })
        .then((response) => response.status),
    ).resolves.toBe(200);

    const markerNames = await readdir(join(root, ".archive"));
    expect(markerNames).toEqual(expect.arrayContaining(["shared", remoteMarker]));

    const archived = await app.request("/api/archived").then((response) => response.json());
    expect(archived).toEqual({ slugs: expect.arrayContaining(["shared", remoteMarker]) });

    await expect(
      app
        .request("/api/archive/shared?targetId=remote-a", { method: "DELETE" })
        .then((response) => response.status),
    ).resolves.toBe(200);
    await expect(readFile(join(root, ".archive", "shared"), "utf-8")).resolves.toBe("");
  });

  it("normalizes legacy raw-target markers after a target is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-archive-legacy-"));
    roots.push(root);
    const configPath = join(root, "empty-config.json");
    process.env.VIBE_REPLAY_CONFIG = configPath;
    await writeFile(configPath, JSON.stringify({ remoteSources: [] }), "utf-8");
    await mkdir(join(root, ".archive"), { recursive: true });
    await mkdir(join(root, "remote-output"), { recursive: true });
    await writeFile(
      join(root, "remote-output", "replay.json"),
      JSON.stringify({
        meta: {
          slug: "source-slug",
          location: { kind: "ssh", id: "remote-a", label: "Remote" },
        },
      }),
      "utf-8",
    );
    await writeFile(join(root, ".archive", "remote-output--ssh-remote-a"), "");

    const archived = await archiveApp(root)
      .request("/api/archived")
      .then((response) => response.json());

    expect(archived).toEqual({
      slugs: [`source-slug--ssh-${sessionLocationHash("remote-a")}`],
    });
  });
});
