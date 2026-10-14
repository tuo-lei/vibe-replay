import { once } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Decompress } from "fzstd";

function createRolloutDecoder(): Transform {
  // Native Node 22 zstd decoding accepts truncated frames and stops at the
  // first concatenated frame. fzstd validates EOF and streams every frame.
  const decoder = new Decompress((bytes) => stream.push(Buffer.from(bytes)));
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        decoder.push(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        decoder.push(new Uint8Array(0), true);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  return stream;
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
      // Highly repetitive histories can expand a small compressed chunk into
      // many blocks before the decoder yields. Limit that queued output.
      const input = createReadStream(
        candidate,
        candidate.endsWith(".jsonl.zst") ? { highWaterMark: 4096 } : undefined,
      );
      try {
        await once(input, "open");
        if (!candidate.endsWith(".jsonl.zst")) return { input, completion: undefined };
        const decoded = createRolloutDecoder();
        const completion = pipeline(input, decoded);
        // The consumer observes errors through the decoded stream/completion.
        // A bounded prefix intentionally cancels the pipeline before EOF.
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
