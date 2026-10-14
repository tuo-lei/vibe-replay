import { once } from "node:events";
import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { Decompress } from "fzstd";

async function* decodeRollout(input: ReadStream): AsyncGenerator<Buffer> {
  // Native Node 22 zstd decoding accepts truncated frames and stops at the
  // first concatenated frame. fzstd validates EOF and streams every frame.
  let output: Buffer[] = [];
  const decoder = new Decompress((bytes) => {
    if (bytes.length) output.push(Buffer.from(bytes));
  });
  try {
    for await (const chunk of input) {
      const bytes = chunk as Buffer;
      // fzstd cannot pause inside push(). Feed at most 64 compressed bytes at
      // once: a zstd block expands to at most 128 KiB and a nonempty RLE block
      // occupies at least four bytes. This bounds a batch to about 2 MiB even
      // for pathological compression ratios, then yields to the consumer.
      for (let offset = 0; offset < bytes.length; offset += 64) {
        decoder.push(bytes.subarray(offset, offset + 64));
        yield* output;
        output = [];
      }
    }
    decoder.push(new Uint8Array(0), true);
    yield* output;
  } finally {
    input.destroy();
  }
}

function rolloutPaths(path: string): string[] {
  const plain = path.endsWith(".jsonl.zst") ? path.slice(0, -4) : path;
  return plain.endsWith(".jsonl") ? [plain, `${plain}.zst`] : [plain];
}

/** Codex retains the logical .jsonl path in SQLite after cold compression. */
export async function resolveCodexRolloutPath(path: string): Promise<string> {
  const candidates = rolloutPaths(path);
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return candidates[0]!;
}

/** Retain an open source so compression/materialization cannot invalidate a read. */
async function openRollout(path: string) {
  const candidates = rolloutPaths(path);
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const candidate of candidates) {
      const input = createReadStream(candidate);
      try {
        await once(input, "open");
        if (!candidate.endsWith(".jsonl.zst")) return { input, completion: undefined };
        const decoded = Readable.from(decodeRollout(input), {
          objectMode: false,
          highWaterMark: 128 * 1024,
        });
        // Destroying a prefix reader must also close a source that its
        // generator has not started reading yet.
        decoded.once("close", () => input.destroy());
        const completion = finished(decoded, { cleanup: true });
        // The consumer observes errors through the decoded stream/completion.
        // A bounded prefix intentionally cancels decoding before EOF.
        void completion.catch(() => {});
        return { input: decoded, completion };
      } catch (error) {
        input.destroy();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (attempt === 1 && candidate === candidates.at(-1)) throw error;
      }
    }
  }
  throw new Error("Could not open Codex rollout");
}

/** Decode in memory without materializing or changing the source rollout. */
export async function* readCodexRolloutLines(path: string): AsyncGenerator<string> {
  const { input, completion } = await openRollout(path);
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    yield* lines;
    await completion;
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Bounded decoded header for CLI provider inference, including renamed rollouts. */
export async function readCodexRolloutPrefix(path: string, maxBytes: number): Promise<string> {
  const { input } = await openRollout(path);
  const chunks: Buffer[] = [];
  let remaining = maxBytes;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const count = Math.min(remaining, bytes.length);
      chunks.push(bytes.subarray(0, count));
      remaining -= count;
      if (remaining === 0) break;
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    input.destroy();
  }
}
