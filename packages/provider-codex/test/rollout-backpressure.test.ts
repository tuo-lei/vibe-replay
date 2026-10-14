import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { expect, it, vi } from "vitest";

const decoded = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("fzstd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fzstd")>();
  return {
    ...actual,
    Decompress: class extends actual.Decompress {
      constructor(ondata?: import("fzstd").ZstdStreamHandler) {
        super((bytes, final) => {
          decoded.bytes += bytes.length;
          return ondata?.(bytes, final);
        });
      }
    },
  };
});
import { readCodexRolloutLines } from "../src/codex/rollout.js";

it("bounds decoded output when a consumer pauses on a highly compressible rollout", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-backpressure-"));
  const path = join(root, "rollout.jsonl.zst");
  const line = JSON.stringify({ type: "event_msg", payload: { message: "x".repeat(1024) } });
  const text = `${line}\n`.repeat(24_000);
  await writeFile(path, zstdCompressSync(Buffer.from(text)));
  decoded.bytes = 0;
  const reader = readCodexRolloutLines(path);
  try {
    expect(await reader.next()).toEqual({ value: line, done: false });
    // Let the stream fill its allowed buffers while the consumer stays paused.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(decoded.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(decoded.bytes).toBeLessThan(Buffer.byteLength(text));
    const hash = createHash("sha256").update(`${line}\n`);
    let count = 1;
    for await (const next of reader) {
      hash.update(`${next}\n`);
      count++;
    }
    expect(count).toBe(24_000);
    expect(hash.digest("hex")).toBe(createHash("sha256").update(text).digest("hex"));
  } finally {
    await reader.return(undefined);
    await rm(root, { recursive: true, force: true });
  }
});
import { createHash } from "node:crypto";
