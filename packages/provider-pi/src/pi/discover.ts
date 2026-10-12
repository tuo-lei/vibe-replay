import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readFileCache, writeFileCache } from "@vibe-replay/provider-core/cache";
import { isSqliteReadOnlyScope, readGitRepo } from "@vibe-replay/provider-core/utils";
import { getPiSessionsDirs } from "./config.js";
const PROMPT_SCAN_LIMIT = 2;
const SCAN_CACHE_KEY = "pi-session-scan-v1";
const SCAN_CONCURRENCY = 8;

const decodedProjectDirCache = new Map<string, string | Promise<string>>();

interface PiSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

export async function discoverPiSessions(
  sessionsRoot?: string,
  resolveGitRepo = true,
  includeUnreplayable = false,
): Promise<SessionInfo[]> {
  if (sessionsRoot === undefined) {
    const sessions: SessionInfo[] = [];
    for (const root of getPiSessionsDirs()) {
      sessions.push(...(await discoverPiSessions(root, resolveGitRepo, includeUnreplayable)));
    }
    sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return sessions;
  }

  const sessions: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(sessionsRoot);
  } catch {
    return sessions;
  }

  const candidates: PiSessionCandidate[] = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(sessionsRoot, projectDir);
    const projectStat = await stat(projectPath).catch(() => null);
    if (!projectStat?.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectPath, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;
      candidates.push({
        filePath,
        projectDir,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        mtime: fileStat.mtime.toISOString(),
      });
    }
  }

  // Pi transcripts are append-only and large (hundreds of MB across a few hundred files), so
  // the per-file scan result is persisted and reused while the file's size/mtime are unchanged.
  const persisted = (await readFileCache<PiScanCache>(SCAN_CACHE_KEY))?.data;
  const cachedEntries =
    persisted && typeof persisted === "object" && !Array.isArray(persisted) ? persisted : {};
  const freshEntries = new Map<string, PiScanCacheEntry>();
  let scannedAny = false;

  const infos = await mapLimit(candidates, SCAN_CONCURRENCY, async (candidate) => {
    let scan: PiFileScan | undefined;
    const cached = cachedEntries[candidate.filePath];
    if (isReusableScanEntry(cached, candidate)) {
      scan = cached.scan;
      freshEntries.set(candidate.filePath, cached);
    } else {
      scannedAny = true;
      scan = await scanPiSessionFile(candidate.filePath);
      // A failed read may be partial, so it is never persisted.
      if (!scan.readFailed) {
        freshEntries.set(candidate.filePath, {
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          scan,
        });
      }
    }
    return buildPiSessionInfo(
      scan,
      candidate.filePath,
      candidate.size,
      candidate.projectDir,
      resolveGitRepo,
      includeUnreplayable,
      candidate.mtime,
    );
  });
  for (const info of infos) if (info) sessions.push(info);

  if (!isSqliteReadOnlyScope()) {
    await persistScanCache(sessionsRoot, freshEntries, scannedAny);
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

interface PiSessionCandidate {
  filePath: string;
  projectDir: string;
  size: number;
  mtimeMs: number;
  mtime: string;
}

/** Everything derived from a transcript's content; independent of discovery options. */
interface PiFileScan {
  header?: Pick<PiSessionHeader, "id" | "version" | "timestamp" | "cwd">;
  timestamp: string;
  title?: string;
  model?: string;
  prompts: string[];
  lineCount: number;
  promptCount: number;
  toolCallCount: number;
  editCountEst: number;
  compactionCount: number;
  sawParseableRecord: boolean;
  readFailed: boolean;
}

interface PiScanCacheEntry {
  size: number;
  mtimeMs: number;
  scan: PiFileScan;
}

type PiScanCache = Record<string, PiScanCacheEntry>;

function isReusableScanEntry(
  entry: PiScanCacheEntry | undefined,
  candidate: PiSessionCandidate,
): entry is PiScanCacheEntry {
  return (
    !!entry &&
    entry.size === candidate.size &&
    entry.mtimeMs === candidate.mtimeMs &&
    !!entry.scan &&
    !entry.scan.readFailed &&
    Array.isArray(entry.scan.prompts)
  );
}

let scanCacheWrite: Promise<void> = Promise.resolve();

/**
 * Persist the entries seen under `root`. Roots are discovered concurrently (local Pi, OMP and
 * staged SSH targets), so the read-merge-write is serialized and merges against the cache as
 * it is *now*, not the snapshot taken before scanning; otherwise the last writer would discard
 * another root's fresh entries. Entries for other roots are kept while their file still
 * exists, and entries for deleted transcripts are dropped so the cache cannot grow forever.
 * The write is skipped when nothing was rescanned and nothing was pruned.
 */
function persistScanCache(
  root: string,
  fresh: Map<string, PiScanCacheEntry>,
  scannedAny: boolean,
): Promise<void> {
  const run = scanCacheWrite.then(() => mergeScanCache(root, fresh, scannedAny));
  scanCacheWrite = run.catch(() => undefined);
  return run;
}

async function mergeScanCache(
  root: string,
  fresh: Map<string, PiScanCacheEntry>,
  scannedAny: boolean,
): Promise<void> {
  const persisted = (await readFileCache<PiScanCache>(SCAN_CACHE_KEY))?.data;
  const previous =
    persisted && typeof persisted === "object" && !Array.isArray(persisted) ? persisted : {};
  const next: PiScanCache = {};
  let pruned = false;
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  for (const [path, entry] of Object.entries(previous)) {
    if (path.startsWith(rootPrefix)) {
      if (fresh.has(path)) continue;
      pruned = true;
    } else if (await stat(path).catch(() => null)) {
      next[path] = entry;
    } else {
      pruned = true;
    }
  }
  for (const [path, entry] of fresh) next[path] = entry;
  if (!scannedAny && !pruned) return;
  await writeFileCache<PiScanCache>(SCAN_CACHE_KEY, next);
}

/** Run `worker` over `items` with bounded concurrency, preserving result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

/** Stream one transcript and reduce it to the content-derived fields discovery reports. */
async function scanPiSessionFile(filePath: string): Promise<PiFileScan> {
  let header: PiSessionHeader | undefined;
  let timestamp = "";
  let lineCount = 0;
  let promptCount = 0;
  let toolCallCount = 0;
  let editCountEst = 0;
  let compactionCount = 0;
  const entryParents = new Map<string, string | null | undefined>();
  const compactionEntryIds = new Set<string>();
  let lastEntryId: string | undefined;
  let model: string | undefined;
  let title: string | undefined;
  const prompts: string[] = [];
  let sawParseableRecord = false;
  let readFailed = false;

  const input = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      lineCount++;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      sawParseableRecord = true;
      if (entry.id) {
        entryParents.set(entry.id, entry.parentId);
        lastEntryId = entry.id;
      }

      if (typeof entry.timestamp === "string" && entry.timestamp) {
        timestamp = entry.timestamp;
      }

      if (!header) {
        if (entry.type === "title" || entry.type === "title_change") {
          const nextTitle = typeof entry.title === "string" ? entry.title.trim() : "";
          if (nextTitle) title = nextTitle;
          continue;
        }
        if (entry.type !== "session" || typeof entry.id !== "string") continue;
        header = entry;
        if (!title && typeof entry.title === "string") title = entry.title.trim() || undefined;
        if (typeof entry.timestamp === "string" && entry.timestamp) timestamp = entry.timestamp;
        continue;
      }

      if (entry.type === "title" || entry.type === "title_change") {
        const nextTitle = typeof entry.title === "string" ? entry.title.trim() : "";
        if (nextTitle) title = nextTitle;
        continue;
      }
      if (entry.type === "session_info") {
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        title = name || title;
        continue;
      }

      if (entry.type === "compaction") {
        if (entry.id) compactionEntryIds.add(entry.id);
        else compactionCount++;
        continue;
      }

      if (entry.type === "model_change") {
        const nextModel = typeof entry.modelId === "string" ? entry.modelId : entry.model;
        if (typeof nextModel === "string" && nextModel) model = nextModel;
        continue;
      }

      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!message || typeof message !== "object") continue;

      if (message.role === "user") {
        const text = extractText(message.content).trim();
        if (text) {
          promptCount++;
          if (prompts.length < PROMPT_SCAN_LIMIT) {
            prompts.push(cleanPromptText(text).slice(0, 200));
          }
        }
      } else if (message.role === "assistant") {
        if (!model && typeof message.model === "string") model = message.model;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block?.type !== "toolCall") continue;
            toolCallCount++;
            if (isEditTool(block.name, block.arguments)) editCountEst++;
          }
        }
      } else if (message.role === "bashExecution") {
        toolCallCount++;
      }
    }
  } catch {
    readFailed = true;
  } finally {
    rl.close();
  }

  if (compactionEntryIds.size > 0) {
    const activeIds = new Set<string>();
    let current = lastEntryId;
    while (current && !activeIds.has(current)) {
      activeIds.add(current);
      const parent = entryParents.get(current);
      current = typeof parent === "string" ? parent : undefined;
    }
    compactionCount += [...compactionEntryIds].filter((id) => activeIds.has(id)).length;
  }

  return {
    header: header
      ? { id: header.id, version: header.version, timestamp: header.timestamp, cwd: header.cwd }
      : undefined,
    timestamp,
    title,
    model,
    prompts,
    lineCount,
    promptCount,
    toolCallCount,
    editCountEst,
    compactionCount,
    sawParseableRecord,
    readFailed,
  };
}

async function buildPiSessionInfo(
  scan: PiFileScan,
  filePath: string,
  fileSize: number,
  encodedProjectDir: string,
  resolveGitRepo = true,
  includeUnreplayable = false,
  fileMtime?: string,
): Promise<SessionInfo | null> {
  const {
    header,
    timestamp,
    title,
    model,
    prompts,
    lineCount,
    promptCount,
    toolCallCount,
    editCountEst,
    compactionCount,
    sawParseableRecord,
    readFailed,
  } = scan;
  if (readFailed && !includeUnreplayable) return null;

  const sessionId = header?.id || basename(filePath, ".jsonl");
  if (!sessionId) return null;

  const cwd = header?.cwd || (await decodeProjectDir(encodedProjectDir));
  const gitRepo = resolveGitRepo ? await readGitRepo(cwd) : undefined;
  const slug = basename(filePath, ".jsonl").replace(/^\d{4}-\d{2}-\d{2}T[^_]+_/, "");
  const fallbackTimestamp =
    timestamp || header?.timestamp || fileMtime || new Date(0).toISOString();
  const unreadable = readFailed || !sawParseableRecord || !header;
  if (!includeUnreplayable && (unreadable || prompts.length === 0)) return null;

  return {
    provider: "pi",
    sessionId,
    slug: slug || sessionId.slice(0, 8),
    title,
    project: cwd,
    cwd,
    version: String(header?.version || 1),
    gitRepo,
    timestamp: fallbackTimestamp,
    lineCount,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: prompts[0] || "",
    prompts: prompts.length > 0 ? prompts : undefined,
    promptCount: unreadable ? 0 : promptCount,
    toolCallCount,
    model,
    editCountEst,
    compactionCount: compactionCount || undefined,
    ...(unreadable || prompts.length === 0
      ? { transcriptStatus: unreadable ? ("unreadable" as const) : ("no-prompts" as const) }
      : {}),
  };
}

export async function decodeProjectDir(encoded: string): Promise<string> {
  const cached = decodedProjectDirCache.get(encoded);
  if (cached !== undefined) return cached;
  const promise = decodeProjectDirUncached(encoded)
    .catch((error) => {
      decodedProjectDirCache.delete(encoded);
      throw error;
    })
    .then((value) => {
      decodedProjectDirCache.set(encoded, value);
      return value;
    });
  decodedProjectDirCache.set(encoded, promise);
  return promise;
}

async function decodeProjectDirUncached(encoded: string): Promise<string> {
  if (encoded.startsWith("--") && encoded.endsWith("--")) {
    const inner = encoded.slice(2, -2);
    const parts = inner.split("-");
    if (process.platform === "win32" && /^[a-zA-Z]$/.test(parts[0] || "")) {
      // Pi drops Windows drive colons and both slash styles when encoding cwd.
      const root = `${parts[0].toUpperCase()}:\\`;
      // The dropped colon and the first separator produce an empty segment
      // after the drive letter (`C--Users-...`).
      const startIdx = parts[1] === "" ? 2 : 1;
      const resolved = await resolveEncodedProjectParts(parts, startIdx, root);
      if (resolved) return joinUnresolvedRemainder(resolved, parts, "\\");
      return parts.length === startIdx ? root : `${root}${parts.slice(startIdx).join("\\")}`;
    }
    const resolved = await resolveEncodedProjectParts(parts, 0, "");
    if (resolved) return joinUnresolvedRemainder(resolved, parts, "/");
    return `/${inner.replace(/-/g, "/")}`;
  }
  return encoded;
}

export function clearDecodedProjectDirCache(): void {
  decodedProjectDirCache.clear();
}

interface PartialResolution {
  path: string;
  nextIdx: number;
}

function joinUnresolvedRemainder(
  resolved: PartialResolution,
  parts: string[],
  separator: string,
): string {
  if (resolved.nextIdx >= parts.length) return resolved.path;
  const remainder = parts.slice(resolved.nextIdx).join("-");
  return resolved.path.endsWith(separator)
    ? `${resolved.path}${remainder}`
    : `${resolved.path}${separator}${remainder}`;
}

async function resolveEncodedProjectParts(
  parts: string[],
  idx: number,
  current: string,
): Promise<PartialResolution | null> {
  if (idx >= parts.length) {
    const candidate = current || "/";
    const currentStat = await stat(candidate).catch(() => null);
    return currentStat?.isDirectory() ? { path: candidate, nextIdx: idx } : null;
  }

  const probePath = current || "/";
  const entries = await readdir(probePath, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return null;

  const dirNames = new Set(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name),
  );

  let deepest: PartialResolution | null = null;

  for (let end = idx + 1; end <= parts.length; end++) {
    const candidate = parts.slice(idx, end).join("-");
    const actual = dirNames.has(candidate)
      ? candidate
      : dirNames.has(`.${candidate}`)
        ? `.${candidate}`
        : null;
    const candidatePath = join(probePath, actual ?? candidate);
    if (!actual) continue;
    const resolved = await resolveEncodedProjectParts(parts, end, candidatePath);
    if (resolved?.nextIdx === parts.length) return resolved;
    const best = resolved ?? { path: candidatePath, nextIdx: end };
    if (!deepest || best.nextIdx > deepest.nextIdx) deepest = best;
  }

  return deepest;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function isEditTool(name: unknown, input: unknown): boolean {
  if (name === "edit" || name === "write" || name === "Edit" || name === "Write") return true;
  if (name !== "apply_patch" || !input || typeof input !== "object") return false;
  const args = input as Record<string, unknown>;
  return [args.input, args.patchText, args.patch].some(
    (value) => typeof value === "string" && value.length > 0,
  );
}
