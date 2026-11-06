// Muse-cloud parity census: discovery + integrity + drift over the 14-day window.
// Shapes and type names only — never raw prompts, tool arguments, or tool outputs.
//
// Coverage: every stable *.jsonl session file in the agents dirs, not just the
// ones discovery returns — a file with a malformed header that discovery
// rejects still gets its corrupt lines counted. Per-file results are staged
// locally and merged only after the file passes the size/mtime stability
// check, so an unstable file contributes nothing to the aggregates.
import { execSync } from "node:child_process";
import { createReadStream, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getMuseAgentsDirs } from "../../packages/provider-muse/src/muse/config.js";
import { discoverMuseSessions } from "../../packages/provider-muse/src/muse/discover.js";
import { parseMuseSession } from "../../packages/provider-muse/src/muse/parser.js";
import type { SessionInfo } from "../../packages/provider-contract/src/index.js";

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const FRESH_MS = 60 * 1000;

type JsonObj = Record<string, unknown>;

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function addSig(map: Map<string, Set<string>>, key: string, sig: string): void {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  s.add(sig);
}

function addCount(map: Map<string, number>, key: string, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

function mergeCounts(into: Map<string, number>, from: Map<string, number>): void {
  for (const [k, v] of from) addCount(into, k, v);
}

function mergeSigs(into: Map<string, Set<string>>, from: Map<string, Set<string>>): void {
  for (const [k, v] of from) for (const sig of v) addSig(into, k, sig);
}

function fieldSig(obj: JsonObj): string {
  return Object.keys(obj)
    .sort()
    .map((k) => `${k}:${typeName(obj[k])}`)
    .join(",");
}

async function* splitNewlineOnly(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf-8" });
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk as string;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf.length > 0) yield buf;
}

/** Per-file staged results: merged into the census only if the file is stable. */
interface FileCensus {
  lines: number;
  corrupt: number;
  corruptDetail: Array<{ session: string; line: number }>;
  promptCount: number;
  toolCallCount: number;
  recordTypes: Map<string, number>;
  recordFieldSigs: Map<string, Set<string>>;
  itemTypes: Map<string, number>;
  itemFieldSigs: Map<string, Set<string>>;
  partTypes: Map<string, number>;
  partSigs: Map<string, Set<string>>;
  toolNames: Map<string, number>;
  toolArgKeys: Map<string, Set<string>>;
  sources: Map<string, number>;
  recordFieldTypes: Map<string, Set<string>>;
  itemFieldTypes: Map<string, Set<string>>;
}

function newFileCensus(): FileCensus {
  return {
    lines: 0,
    corrupt: 0,
    corruptDetail: [],
    promptCount: 0,
    toolCallCount: 0,
    recordTypes: new Map(),
    recordFieldSigs: new Map(),
    itemTypes: new Map(),
    itemFieldSigs: new Map(),
    partTypes: new Map(),
    partSigs: new Map(),
    toolNames: new Map(),
    toolArgKeys: new Map(),
    sources: new Map(),
    recordFieldTypes: new Map(),
    itemFieldTypes: new Map(),
  };
}

function mergeFileCensus(into: FileCensus, from: FileCensus): void {
  into.lines += from.lines;
  into.corrupt += from.corrupt;
  into.corruptDetail.push(...from.corruptDetail);
  into.promptCount += from.promptCount;
  into.toolCallCount += from.toolCallCount;
  mergeCounts(into.recordTypes, from.recordTypes);
  mergeSigs(into.recordFieldSigs, from.recordFieldSigs);
  mergeCounts(into.itemTypes, from.itemTypes);
  mergeSigs(into.itemFieldSigs, from.itemFieldSigs);
  mergeCounts(into.partTypes, from.partTypes);
  mergeSigs(into.partSigs, from.partSigs);
  mergeCounts(into.toolNames, from.toolNames);
  mergeSigs(into.toolArgKeys, from.toolArgKeys);
  mergeCounts(into.sources, from.sources);
  mergeSigs(into.recordFieldTypes, from.recordFieldTypes);
  mergeSigs(into.itemFieldTypes, from.itemFieldTypes);
}

/** Stream one file's lines into a staged census. Throws on stream errors. */
async function streamFileCensus(file: string, shortId: string): Promise<FileCensus> {
  const fc = newFileCensus();
  let lineNo = 0;
  for await (const line of splitNewlineOnly(file)) {
    lineNo++;
    fc.lines++;
    if (!line.trim()) continue;
    let rec: JsonObj;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      rec = parsed as JsonObj;
    } catch {
      fc.corrupt++;
      fc.corruptDetail.push({ session: shortId, line: lineNo });
      continue;
    }
    if (typeof rec.type === "string") {
      addCount(fc.recordTypes, rec.type, 1);
      addSig(fc.recordFieldSigs, rec.type, fieldSig(rec));
    }
    for (const [k, v] of Object.entries(rec)) {
      addSig(fc.recordFieldTypes, `${rec.type ?? "?"}:${k}`, typeName(v));
    }
    if (typeof rec.source === "string") {
      addCount(fc.sources, rec.source, 1);
    }
    const item = rec.item as JsonObj | undefined;
    if (item && typeof item === "object") {
      if (typeof item.type === "string") {
        addCount(fc.itemTypes, item.type, 1);
        addSig(fc.itemFieldSigs, item.type, fieldSig(item));
      }
      for (const [k, v] of Object.entries(item)) {
        addSig(fc.itemFieldTypes, `${item.type ?? "?"}:${k}`, typeName(v));
      }
      // user-prompt census: user role with text/parts (message and message_parts both count, like discovery's scanLine)
      if ((item.type === "message" || item.type === "message_parts") && item.role === "user")
        fc.promptCount++;
      if (item.type === "function_call") {
        fc.toolCallCount++;
        const name = typeof item.name === "string" ? item.name : "?";
        addCount(fc.toolNames, name, 1);
        if (typeof item.arguments === "string") {
          try {
            const args = JSON.parse(item.arguments) as JsonObj;
            if (args && typeof args === "object") {
              addSig(fc.toolArgKeys, name, Object.keys(args).sort().join(","));
            }
          } catch {
            addSig(fc.toolArgKeys, name, "<unparseable-arguments>");
          }
        } else if (item.arguments !== undefined) {
          addSig(fc.toolArgKeys, name, `<arguments:${typeName(item.arguments)}>`);
        }
      }
      if (item.type === "message_parts" && Array.isArray(item.parts)) {
        for (const part of item.parts as JsonObj[]) {
          if (part && typeof part === "object" && typeof part.type === "string") {
            addCount(fc.partTypes, part.type, 1);
            addSig(fc.partSigs, part.type, fieldSig(part));
          }
        }
      }
    }
  }
  return fc;
}

/** Enumerate every *.jsonl session file under the Muse agents roots. */
async function enumerateSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of getMuseAgentsDirs()) {
    const agentDirs = await readdir(root).catch(() => [] as string[]);
    for (const agentDir of agentDirs) {
      const sessionsDir = join(root, agentDir, "sessions");
      const names = await readdir(sessionsDir).catch(() => [] as string[]);
      for (const name of names) {
        if (name.endsWith(".jsonl")) files.push(join(sessionsDir, name));
      }
    }
  }
  return files;
}

async function main(): Promise<void> {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const runDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const discovered = await discoverMuseSessions();
  const inWindow = discovered.filter((s) => Date.parse(s.timestamp) >= cutoff);
  const discoveredByPath = new Map<string, SessionInfo>();
  for (const s of inWindow) discoveredByPath.set(s.filePath, s);

  const totals = newFileCensus();
  let filesStreamed = 0;
  let filesSkippedFresh = 0;
  let filesUnstable = 0;
  let parseThrows = 0;
  let parseWarnings = 0;
  const zeroPromptToolCalls: string[] = [];
  let discoveryPromptTotal = 0;
  let discoveryToolTotal = 0;
  const parseThrowDetail: Array<{ session: string; error: string }> = [];
  const warningDetail: Array<{ session: string; warnings: number }> = [];
  const streamErrors: Array<{ session: string; error: string }> = [];
  const filesNotDiscovered: Array<{ session: string; lines: number; corrupt: number }> = [];

  for (const file of await enumerateSessionFiles()) {
    const st0 = await stat(file).catch(() => null);
    if (!st0) continue;
    if (now - st0.mtimeMs < FRESH_MS) {
      filesSkippedFresh++;
      continue;
    }
    if (st0.mtimeMs < cutoff) continue; // outside the 14-day window by file mtime
    const session = discoveredByPath.get(file);
    const shortId = session
      ? session.sessionId.slice(0, 8)
      : (file
          .split("/")
          .at(-1)
          ?.replace(/\.jsonl$/, "")
          .slice(0, 8) ?? "?");
    let fc: FileCensus;
    try {
      fc = await streamFileCensus(file, shortId);
    } catch (err) {
      // Stream failure: record it, discard any partial counts, keep going.
      streamErrors.push({ session: shortId, error: String(err).slice(0, 120) });
      continue;
    }
    const st1 = await stat(file).catch(() => null);
    if (!st1 || st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) {
      filesUnstable++;
      continue; // staged results discarded — do not trust a file that moved mid-read
    }
    mergeFileCensus(totals, fc);
    filesStreamed++;
    if (!session) {
      filesNotDiscovered.push({ session: shortId, lines: fc.lines, corrupt: fc.corrupt });
    } else {
      discoveryPromptTotal += session.promptCount ?? 0;
      discoveryToolTotal += session.toolCallCount ?? 0;
    }
    // Parse check (provider's own parser, same input the CLI uses)
    try {
      const parsed = await parseMuseSession(file);
      const warns = parsed.parseWarnings?.length ?? 0;
      if (warns > 0) {
        parseWarnings += warns;
        warningDetail.push({ session: shortId, warnings: warns });
      }
      if (session) {
        const userTurns = parsed.turns.filter((t) => t.role === "user").length;
        if (
          ((session.promptCount ?? 0) === 0 || userTurns === 0) &&
          (session.toolCallCount ?? 0) > 0
        ) {
          zeroPromptToolCalls.push(shortId);
        }
      }
    } catch (err) {
      parseThrows++;
      parseThrowDetail.push({ session: shortId, error: String(err).slice(0, 120) });
    }
  }

  const base = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();

  const out = {
    base,
    runDate,
    discoveredTotal: discovered.length,
    inWindow: inWindow.length,
    filesStreamed,
    filesSkippedFresh,
    filesUnstable,
    filesNotDiscovered,
    streamErrors,
    totalLines: totals.lines,
    corruptLines: totals.corrupt,
    corruptDetail: totals.corruptDetail.slice(0, 20),
    parseThrows,
    parseThrowDetail,
    parseWarnings,
    warningDetail: warningDetail.slice(0, 20),
    zeroPromptToolCalls,
    censusPromptCount: totals.promptCount,
    censusToolCallCount: totals.toolCallCount,
    discoveryPromptTotal,
    discoveryToolTotal,
    recordTypes: Object.fromEntries(totals.recordTypes),
    recordFieldSigCounts: Object.fromEntries(
      [...totals.recordFieldSigs].map(([k, v]) => [k, [...v]]),
    ),
    itemTypes: Object.fromEntries(totals.itemTypes),
    itemFieldSigCounts: Object.fromEntries([...totals.itemFieldSigs].map(([k, v]) => [k, [...v]])),
    partTypes: Object.fromEntries(totals.partTypes),
    partSigs: Object.fromEntries([...totals.partSigs].map(([k, v]) => [k, [...v]])),
    toolNames: Object.fromEntries(totals.toolNames),
    toolArgKeys: Object.fromEntries([...totals.toolArgKeys].map(([k, v]) => [k, [...v]])),
    sources: Object.fromEntries(totals.sources),
    recordFieldTypes: Object.fromEntries([...totals.recordFieldTypes].map(([k, v]) => [k, [...v]])),
    itemFieldTypes: Object.fromEntries([...totals.itemFieldTypes].map(([k, v]) => [k, [...v]])),
    newestSessions: inWindow.slice(0, 5).map((s) => ({
      id: s.sessionId.slice(0, 8),
      timestamp: s.timestamp,
      promptCount: s.promptCount,
      toolCallCount: s.toolCallCount,
      lineCount: s.lineCount,
    })),
  };

  writeFileSync(new URL(`./census-${runDate}.json`, import.meta.url), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

void main();
