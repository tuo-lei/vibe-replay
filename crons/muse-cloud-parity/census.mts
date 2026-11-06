// Muse-cloud parity census: discovery + integrity + drift over the 14-day window.
// Shapes and type names only — never raw prompts, tool arguments, or tool outputs.
import { execSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { discoverMuseSessions } from "../../packages/provider-muse/src/muse/discover.js";
import { parseMuseSession } from "../../packages/provider-muse/src/muse/parser.js";

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

async function main(): Promise<void> {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const discovered = await discoverMuseSessions();
  const inWindow = discovered.filter((s) => Date.parse(s.timestamp) >= cutoff);

  const recordTypes = new Map<string, number>();
  const recordFieldSigs = new Map<string, Set<string>>();
  const itemTypes = new Map<string, number>();
  const itemFieldSigs = new Map<string, Set<string>>();
  const partTypes = new Map<string, number>();
  const partSigs = new Map<string, Set<string>>();
  const toolNames = new Map<string, number>();
  const toolArgKeys = new Map<string, Set<string>>();
  const sources = new Map<string, number>();
  const recordFieldTypes = new Map<string, Set<string>>();
  const itemFieldTypes = new Map<string, Set<string>>();

  let filesStreamed = 0;
  let filesSkippedFresh = 0;
  let filesUnstable = 0;
  let totalLines = 0;
  let corruptLines = 0;
  let parseThrows = 0;
  let parseWarnings = 0;
  const zeroPromptToolCalls: string[] = [];
  let censusPromptCount = 0;
  let censusToolCallCount = 0;
  let discoveryPromptTotal = 0;
  let discoveryToolTotal = 0;
  const corruptDetail: Array<{ session: string; line: number }> = [];
  const parseThrowDetail: Array<{ session: string; error: string }> = [];
  const warningDetail: Array<{ session: string; warnings: number }> = [];

  for (const session of inWindow) {
    const file = session.filePath;
    const st0 = await stat(file).catch(() => null);
    if (!st0) continue;
    if (now - st0.mtimeMs < FRESH_MS) {
      filesSkippedFresh++;
      continue;
    }
    discoveryPromptTotal += session.promptCount ?? 0;
    discoveryToolTotal += session.toolCallCount ?? 0;
    let lineNo = 0;
    for await (const line of splitNewlineOnly(file)) {
      lineNo++;
      totalLines++;
      if (!line.trim()) continue;
      let rec: JsonObj;
      try {
        rec = JSON.parse(line) as JsonObj;
      } catch {
        corruptLines++;
        corruptDetail.push({ session: session.sessionId.slice(0, 8), line: lineNo });
        continue;
      }
      if (typeof rec.type === "string") {
        recordTypes.set(rec.type, (recordTypes.get(rec.type) ?? 0) + 1);
        addSig(recordFieldSigs, rec.type, fieldSig(rec));
      }
      for (const [k, v] of Object.entries(rec)) {
        addSig(recordFieldTypes, `${rec.type ?? "?"}:${k}`, typeName(v));
      }
      if (typeof rec.source === "string") {
        sources.set(rec.source, (sources.get(rec.source) ?? 0) + 1);
      }
      const item = rec.item as JsonObj | undefined;
      if (item && typeof item === "object") {
        if (typeof item.type === "string") {
          itemTypes.set(item.type, (itemTypes.get(item.type) ?? 0) + 1);
          addSig(itemFieldSigs, item.type, fieldSig(item));
        }
        for (const [k, v] of Object.entries(item)) {
          addSig(itemFieldTypes, `${item.type ?? "?"}:${k}`, typeName(v));
        }
        // user-prompt census: user role with text/parts (message and message_parts both count, like discovery's scanLine)
        if ((item.type === "message" || item.type === "message_parts") && item.role === "user")
          censusPromptCount++;
        if (item.type === "function_call") {
          censusToolCallCount++;
          const name = typeof item.name === "string" ? item.name : "?";
          toolNames.set(name, (toolNames.get(name) ?? 0) + 1);
          if (typeof item.arguments === "string") {
            try {
              const args = JSON.parse(item.arguments) as JsonObj;
              if (args && typeof args === "object") {
                addSig(toolArgKeys, name, Object.keys(args).sort().join(","));
              }
            } catch {
              addSig(toolArgKeys, name, "<unparseable-arguments>");
            }
          } else if (item.arguments !== undefined) {
            addSig(toolArgKeys, name, `<arguments:${typeName(item.arguments)}>`);
          }
        }
        if (item.type === "message_parts" && Array.isArray(item.parts)) {
          for (const part of item.parts as JsonObj[]) {
            if (part && typeof part === "object" && typeof part.type === "string") {
              partTypes.set(part.type, (partTypes.get(part.type) ?? 0) + 1);
              addSig(partSigs, part.type, fieldSig(part));
            }
          }
        }
      }
    }
    const st1 = await stat(file).catch(() => null);
    if (!st1 || st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) {
      filesUnstable++;
      continue; // do not trust counts from a file that moved during the read
    }
    filesStreamed++;
    // Parse check (provider's own parser, same input the CLI uses)
    try {
      const parsed = await parseMuseSession(file);
      const warns = parsed.parseWarnings?.length ?? 0;
      if (warns > 0) {
        parseWarnings += warns;
        warningDetail.push({ session: session.sessionId.slice(0, 8), warnings: warns });
      }
      const userTurns = parsed.turns.filter((t) => t.role === "user").length;
      if ((session.promptCount ?? 0) === 0 && (session.toolCallCount ?? 0) > 0) {
        zeroPromptToolCalls.push(session.sessionId.slice(0, 8));
      }
      void userTurns;
    } catch (err) {
      parseThrows++;
      parseThrowDetail.push({
        session: session.sessionId.slice(0, 8),
        error: String(err).slice(0, 120),
      });
    }
  }

  const base = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();

  const out = {
    base,
    discoveredTotal: discovered.length,
    inWindow: inWindow.length,
    filesStreamed,
    filesSkippedFresh,
    filesUnstable,
    totalLines,
    corruptLines,
    corruptDetail: corruptDetail.slice(0, 20),
    parseThrows,
    parseThrowDetail,
    parseWarnings,
    warningDetail: warningDetail.slice(0, 20),
    zeroPromptToolCalls,
    censusPromptCount,
    censusToolCallCount,
    discoveryPromptTotal,
    discoveryToolTotal,
    recordTypes: Object.fromEntries(recordTypes),
    recordFieldSigCounts: Object.fromEntries([...recordFieldSigs].map(([k, v]) => [k, [...v]])),
    itemTypes: Object.fromEntries(itemTypes),
    itemFieldSigCounts: Object.fromEntries([...itemFieldSigs].map(([k, v]) => [k, [...v]])),
    partTypes: Object.fromEntries(partTypes),
    partSigs: Object.fromEntries([...partSigs].map(([k, v]) => [k, [...v]])),
    toolNames: Object.fromEntries(toolNames),
    toolArgKeys: Object.fromEntries([...toolArgKeys].map(([k, v]) => [k, [...v]])),
    sources: Object.fromEntries(sources),
    recordFieldTypes: Object.fromEntries([...recordFieldTypes].map(([k, v]) => [k, [...v]])),
    itemFieldTypes: Object.fromEntries([...itemFieldTypes].map(([k, v]) => [k, [...v]])),
    newestSessions: inWindow.slice(0, 5).map((s) => ({
      id: s.sessionId.slice(0, 8),
      timestamp: s.timestamp,
      promptCount: s.promptCount,
      toolCallCount: s.toolCallCount,
      lineCount: s.lineCount,
    })),
  };

  writeFileSync(new URL("./census-2026-11-06.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

void main();
