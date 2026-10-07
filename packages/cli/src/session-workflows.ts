import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ReplaySession, Scene, SessionInfo } from "./types.js";
import { readFileCache, writeFileCache } from "./cache.js";
import { discoverProvidersSafely, type SafeProviderDiscoveryResult } from "./provider-discovery.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import { mergeSameSessions } from "./session-merge.js";
import { expandUserPath, shortenPath } from "./utils.js";
import { transformToReplay } from "./transform.js";
import { getRemoteHome, hydrateCachedRemoteHomes } from "./remote.js";
import { hasReplayableContent, replayOutputSlug } from "./server-core.js";
import { generateOutput } from "./generator.js";
import { generateGitHubMarkdown } from "./formatters/github.js";
import { loadSavedCloudInfo } from "./publishers/cloud.js";
import { loadSavedGistInfo } from "./publishers/gist.js";
import { loadOverlays, sessionForExternalOutput, sessionWithEffectiveContent } from "./overlays.js";
import { loadAnnotations } from "./server-persistence.js";
import { scanForSecrets } from "./scan.js";
import { assertSqliteWalReadable, withReadOnlySqlite } from "@vibe-replay/provider-core/utils";
import { inferSqliteProvider } from "./sqlite-schema.js";
import { parseGrokBotMetaWake } from "@vibe-replay/provider-grok-bot/parser";
import { CLI_VERSION } from "./version.js";

export interface SessionReferenceOptions {
  provider?: string;
  target?: string;
  refresh?: boolean;
  readOnly?: boolean;
  source?: boolean;
  snapshot?: boolean;
  revision?: string;
}

export async function discoverCliSessions(options: SessionReferenceOptions = {}) {
  const providers = options.provider ? [getProvider(options.provider)] : getAllProviders();
  if (providers.some((p) => !p)) throw new Error(`Unknown provider: ${options.provider}`);
  const key = `cli-discovery-v1-${options.provider || "all"}`;
  const cached = options.refresh ? null : await readFileCache<SafeProviderDiscoveryResult>(key);
  if (cached && Date.now() - Date.parse(cached.updatedAt) < 30_000) {
    return {
      ...cached.data,
      sessions: mergeSameSessions(cached.data.sessions),
      source: "cache",
      updatedAt: cached.updatedAt,
    };
  }
  const discovery = await withReadOnlySqlite(!!options.readOnly, () =>
    discoverProvidersSafely(
      providers.filter((p) => p !== undefined),
      undefined,
      {
        readOnly: options.readOnly,
      },
    ),
  );
  if (!options.readOnly) await writeFileCache(key, discovery);
  return {
    ...discovery,
    sessions: mergeSameSessions(discovery.sessions),
    source: "fresh",
    updatedAt: new Date().toISOString(),
  };
}

export class SessionReferenceError extends Error {
  constructor(
    readonly code: "not-found" | "ambiguous",
    message: string,
  ) {
    super(message);
  }
}

export function resolveSessionReference(
  sessions: SessionInfo[],
  ref: string,
  options: SessionReferenceOptions = {},
): SessionInfo {
  const scoped = sessions.filter(
    (s) =>
      (!options.provider || s.provider === options.provider) &&
      (!options.target ||
        (s.location?.kind === "ssh" ? s.location.id : "local") === options.target),
  );
  const expanded = expandUserPath(ref);
  const storage = splitStorageReference(expanded);
  if (storage.suffix && !storage.marker) throw new Error("Session marker must contain an ID");
  const referencePath =
    storage.suffix || /[/\\]/.test(storage.base) || pathExists(storage.base)
      ? canonicalStoragePath(storage.base)
      : undefined;
  const storageMatches = referencePath
    ? scoped.filter((s) =>
        [s.filePath, ...s.filePaths]
          .filter(Boolean)
          .some((candidate) => canonicalStoragePath(candidate) === referencePath),
      )
    : [];
  if (storage.marker && storageMatches.length)
    return resolveSessionReference(storageMatches, storage.marker, options);
  const exact = scoped.filter(
    (s) =>
      (!storage.suffix && storageMatches.includes(s)) ||
      [s.sessionId, ...(s.sessionIds || []), s.slug, s.filePath, ...s.filePaths].some(
        (id) => id === ref || id === expanded || id === resolve(expanded),
      ),
  );
  const matches = exact.length
    ? exact
    : ref.length >= 4
      ? scoped.filter((s) =>
          [s.sessionId, ...(s.sessionIds || []), s.slug].some((id) => id.startsWith(ref)),
        )
      : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new SessionReferenceError(
      "ambiguous",
      `Ambiguous session reference '${ref}'. Use a full ID, --provider, or --target: ${matches
        .slice(0, 10)
        .map(
          (s) =>
            `${s.provider}:${s.sessionId} (${s.location?.kind === "ssh" ? s.location.id : "local"})`,
        )
        .join(", ")}`,
    );
  throw new SessionReferenceError(
    "not-found",
    `Session '${ref}' not found. Run 'vibe-replay sessions --any --brief' or retry with --refresh.`,
  );
}

function splitStorageReference(ref: string) {
  const match = /#(?:session|composerData):/.exec(ref);
  return {
    base: match ? ref.slice(0, match.index) : ref,
    marker: match ? ref.slice(match.index + match[0].length) : undefined,
    suffix: match ? ref.slice(match.index) : "",
  };
}

function canonicalStoragePath(ref: string): string {
  const path = resolve(expandUserPath(splitStorageReference(ref).base));
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function pathExists(ref: string): boolean {
  return existsSync(splitStorageReference(expandUserPath(ref)).base);
}

async function isSqliteFile(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead === 16 && buffer.toString("utf-8") === "SQLite format 3\0";
  } finally {
    await file.close();
  }
}

async function discoverDatabaseSessions(path: string, provider: string): Promise<SessionInfo[]> {
  if (provider === "cursor") {
    const { discoverCursorDatabaseSessions } =
      await import("@vibe-replay/provider-cursor/sqlite-reader");
    return discoverCursorDatabaseSessions(path);
  }
  if (provider === "hermes") {
    const { openHermesDb } = await import("@vibe-replay/provider-hermes/sqlite");
    const { listSessionsFromDb } = await import("@vibe-replay/provider-hermes/discover");
    const opened = await openHermesDb(path);
    if (!opened) throw new Error("Cannot read the supplied Hermes database");
    try {
      return listSessionsFromDb(opened.db, path);
    } finally {
      opened.db.close();
    }
  }
  if (provider === "opencode") {
    const { openOpencodeDb } = await import("@vibe-replay/provider-opencode/sqlite");
    const { listSessionsFromDb } = await import("@vibe-replay/provider-opencode/discover");
    const opened = await openOpencodeDb(path);
    if (!opened) throw new Error("Cannot read the supplied OpenCode database");
    try {
      return listSessionsFromDb(opened.db).map((session) => ({
        ...session,
        filePath: `${path}#session:${session.sessionId}`,
        filePaths: [`${path}#session:${session.sessionId}`],
      }));
    } finally {
      opened.db.close();
    }
  }
  return [];
}

/** Read complete records, or only complete scalar root fields of a bounded partial record. */
function inferenceRecord(line: string): Record<string, any> | undefined {
  try {
    const record = JSON.parse(line);
    return record && typeof record === "object" && !Array.isArray(record) ? record : undefined;
  } catch {
    // Format headers precede nested message/payload bodies. This anchored prefix
    // cannot mistake a nested tool payload or progress artifact for a header.
    const prefix =
      /^\s*\{\s*(?:"(?:[^"\\]|\\.)*"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\s*,\s*)*/.exec(
        line,
      )?.[0];
    if (!prefix) return undefined;
    try {
      return JSON.parse(`${prefix.replace(/,\s*$/, "")}}`);
    } catch {
      return undefined;
    }
  }
}

function grokTranscriptEvidence(
  head: string,
  allowMetaWakeInference: boolean,
): "grok-bot" | "ambiguous" | undefined {
  let hasMetaWake = false;
  let hasMessageEnvelope = false;
  let hasCursorToolId = false;
  let hasSandToolId = false;
  for (const line of head.split("\n")) {
    try {
      const record = JSON.parse(line);
      const blocks = record?.message?.content;
      if (!Array.isArray(blocks)) continue;
      if (
        record.role === "user" &&
        blocks.some(
          (block) =>
            block?.type === "text" &&
            typeof block.text === "string" &&
            (/^\s*\[SAND_HIDDEN_PROMPT\]/.test(block.text) ||
              /^\s*\[(?:t\d+u\]|Group chat:)/i.test(block.text)),
        )
      )
        return "grok-bot";
      if (record.role === "user")
        hasMetaWake ||= blocks.some(
          (block) =>
            block?.type === "text" &&
            typeof block.text === "string" &&
            parseGrokBotMetaWake(block.text) !== null,
        );
      if (record.role === "assistant") {
        hasCursorToolId ||= blocks.some(
          (block) =>
            block?.type === "tool_use" &&
            typeof block.id === "string" &&
            block.id.trim().length > 0,
        );
        hasSandToolId ||= blocks.some(
          (block) =>
            block?.type === "tool_use" &&
            [block.toolCallId, block.tool_call_id].some(
              (id) => typeof id === "string" && id.trim().length > 0,
            ),
        );
        hasMessageEnvelope ||= blocks.some(
          (block) =>
            block?.type === "tool_use" &&
            block.name === "send_message" &&
            typeof block.input?.text?.content === "string",
        );
      }
    } catch {
      /* The bounded header can end halfway through a record. */
    }
  }
  // Missing tool IDs are supported by both parsers. Never treat their absence
  // as provider identity; a shared wake/reply shape needs an explicit choice.
  if (allowMetaWakeInference && !hasCursorToolId && hasMetaWake && hasMessageEnvelope)
    return hasSandToolId ? "grok-bot" : "ambiguous";
  return undefined;
}

async function inferProvider(path: string): Promise<string> {
  const { base, marker, suffix } = splitStorageReference(path);
  const cursorPath = /(?:^|[/\\])(?:\.cursor|Cursor)[/\\]/i.test(base);
  if (suffix.startsWith("#composerData:") || (marker && cursorPath)) return "cursor";
  const file = await open(base, "r");
  let head: string;
  let initialRecordIncomplete = false;
  try {
    const buffer = Buffer.alloc(64_000);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead).toString("utf-8");
    // Grok and Cursor share role/message envelopes. Complete the record that
    // crosses the probe boundary, including after leading progress events.
    if (
      bytesRead === buffer.length &&
      !head.endsWith("\n") &&
      !head.startsWith("SQLite format 3\0")
    ) {
      const chunks = [buffer.subarray(0, bytesRead)];
      let offset = bytesRead;
      const limit = 1024 * 1024;
      while (offset < limit) {
        const extra = Buffer.alloc(Math.min(64_000, limit - offset));
        const next = await file.read(extra, 0, extra.length, offset);
        if (!next.bytesRead) break;
        const newline = extra.subarray(0, next.bytesRead).indexOf(10);
        const count = newline >= 0 ? newline + 1 : next.bytesRead;
        chunks.push(extra.subarray(0, count));
        offset += count;
        if (newline >= 0 || next.bytesRead < extra.length) break;
      }
      head = Buffer.concat(chunks).toString("utf-8");
      if (offset === limit && !head.endsWith("\n")) {
        try {
          JSON.parse(head.slice(head.lastIndexOf("\n") + 1));
        } catch {
          initialRecordIncomplete = true;
        }
      }
    }
  } finally {
    await file.close();
  }
  const sqlite = head.startsWith("SQLite format 3\0");
  if (sqlite) {
    const provider = await inferSqliteProvider(base);
    if (provider) return provider;
  }
  if (marker || /\.(?:db|sqlite|vscdb)$/i.test(base)) {
    if (cursorPath) return "cursor";
    if (base.includes("opencode")) return "opencode";
    if (base.includes("hermes")) return "hermes";
  }
  if (sqlite) throw new Error("Could not infer the SQLite provider. Specify --provider <name>.");
  head = head
    .split("\n")
    .filter((line) => {
      try {
        return inferenceRecord(line)?.type !== "progress";
      } catch {
        return true;
      }
    })
    .join("\n");
  const headers = head.split("\n").map(inferenceRecord).filter(Boolean);
  if (headers.some((record) => record?.type === "session_meta")) return "codex";
  if (headers.some((record) => record?.type === "session" && record.version !== undefined))
    return "pi";
  if (
    headers.some(
      (record) =>
        ["user", "assistant", "system"].includes(record?.type) &&
        (typeof record?.sessionId === "string" || typeof record?.uuid === "string"),
    )
  )
    return "claude-code";
  const grokEvidence = grokTranscriptEvidence(head, !cursorPath);
  if (grokEvidence === "grok-bot") return "grok-bot";
  if (cursorPath) return "cursor";
  if (/[/\\](?:\.?grok-bot|agent-data|sand-data)[/\\]/i.test(base)) return "grok-bot";
  if (grokEvidence === "ambiguous")
    throw new Error(
      "Ambiguous Cursor/Grok Bot source. Specify --provider cursor or --provider grok-bot.",
    );
  if (initialRecordIncomplete) {
    throw new Error(
      "A source record crosses the 1 MiB provider-inference limit. Specify --provider <name>.",
    );
  }
  if (
    /\[user\]/.test(head) ||
    (/"role"\s*:\s*"(?:user|assistant)"/.test(head) && /"message"\s*:/.test(head))
  )
    return "cursor";
  throw new Error("Could not infer the provider from this source. Specify --provider <name>.");
}

export async function resolveCliSource(
  ref: string,
  options: SessionReferenceOptions = {},
  suppliedDiscovery?: Awaited<ReturnType<typeof discoverCliSessions>>,
) {
  const expanded = expandUserPath(ref);
  const { base, marker, suffix } = splitStorageReference(expanded);
  if (suffix && !marker) throw new Error("Session marker must contain an ID");
  const path = resolve(base) + suffix;
  if (pathExists(path)) {
    if (options.readOnly && (await isSqliteFile(base)))
      await withReadOnlySqlite(true, () => assertSqliteWalReadable(base));
    const provider =
      options.provider || (await withReadOnlySqlite(!!options.readOnly, () => inferProvider(path)));
    if (!getProvider(provider)) throw new Error(`Unknown provider: ${provider}`);
    // Provider-scoped metadata preserves discovered titles and enriches DB/sidecar sources.
    const discovery = suppliedDiscovery ?? (await discoverCliSessions({ ...options, provider }));
    const referencePath = canonicalStoragePath(base);
    const matches = discovery.sessions.filter((s) =>
      [s.filePath, ...s.filePaths]
        .filter(Boolean)
        .some((candidate) => canonicalStoragePath(candidate) === referencePath),
    );
    const explicitDatabase =
      ["hermes", "opencode", "cursor"].includes(provider) && (await isSqliteFile(base));
    if (!matches.length && explicitDatabase) {
      matches.push(
        ...(await withReadOnlySqlite(!!options.readOnly, () =>
          discoverDatabaseSessions(resolve(base), provider),
        )),
      );
      if (!marker && !matches.length)
        throw new SessionReferenceError(
          "not-found",
          "The supplied database has no replayable sessions. Use a #session:<id> marker for a specific session.",
        );
    }
    if (provider === "cursor" && explicitDatabase)
      for (let index = 0; index < matches.length; index++)
        matches[index] = { ...matches[index], sourceDatabasePath: resolve(base) };
    const scoped = options.target
      ? matches.filter(
          (s) => (s.location?.kind === "ssh" ? s.location.id : "local") === options.target,
        )
      : matches;
    if (matches.length && !scoped.length)
      throw new Error(`Source does not belong to target '${options.target}'`);
    if (!marker && scoped.length > 1)
      throw new SessionReferenceError(
        "ambiguous",
        `Ambiguous storage path '${ref}'. Use a session ID or a #session:<id> marker: ${scoped
          .slice(0, 10)
          .map((s) => s.sessionId)
          .join(", ")}`,
      );
    const info =
      marker && scoped.length ? resolveSessionReference(scoped, marker, options) : scoped[0];
    const target = info?.location?.kind === "ssh" ? info.location.id : "local";
    if (options.target && target !== options.target)
      throw new Error(`Source belongs to target '${target}', not '${options.target}'`);
    return {
      provider,
      info,
      paths: info ? [...info.filePaths, ...(info.toolPaths || [])] : [path],
      discovery,
    };
  }
  const discovery = suppliedDiscovery ?? (await discoverCliSessions(options));
  let info: SessionInfo;
  try {
    info = resolveSessionReference(discovery.sessions, ref, options);
  } catch (error) {
    if (error instanceof SessionReferenceError && discovery.failedProviders.length) {
      const checkpoint = discovery.coverage.find(
        (entry) => entry.errorCode === "checkpoint-required",
      );
      error.message += ` Discovery incomplete: ${discovery.failedProviders.join(", ")}${checkpoint ? `. ${checkpoint.message}` : "; run vibe-replay doctor --json."}`;
    }
    throw error;
  }
  return {
    provider: info.provider,
    info,
    paths: [...info.filePaths, ...(info.toolPaths || [])],
    discovery,
  };
}

export async function resolveCliSessionInfo(
  ref: string,
  options: SessionReferenceOptions = {},
  discovery?: Awaited<ReturnType<typeof discoverCliSessions>>,
): Promise<SessionInfo> {
  const source = await resolveCliSource(ref, options, discovery);
  if (source.info && !(source.info.sourceDatabasePath && !source.info.transcriptStatus))
    return source.info;
  const parsed = await withReadOnlySqlite(!!options.readOnly, () =>
    getProvider(source.provider)!.parse(source.paths, source.info),
  );
  const replay = transformToReplay(parsed, source.provider, shortenPath(parsed.cwd));
  if (!hasReplayableContent(replay)) throw new Error("This session has no replayable user prompts");
  const prompts = replay.scenes
    .filter((scene) => scene.type === "user-prompt")
    .map((scene) => scene.content);
  if (source.info?.sourceDatabasePath && !source.info.hasSdk)
    return {
      ...source.info,
      title: parsed.title || source.info.title,
      firstPrompt: prompts[0] || "",
      prompts,
      promptCount: prompts.length,
      toolCallCount: replay.meta.stats.toolCalls,
      compactionCount: parsed.compactions?.length || 0,
      model: parsed.model,
    };
  const files = await Promise.all(
    source.paths.map(async (path) => ({
      metadata: await stat(path),
      text: await readFile(path, "utf-8"),
    })),
  );
  return {
    provider: source.provider,
    sessionId: parsed.sessionId,
    slug: parsed.slug,
    title: parsed.title,
    project: shortenPath(parsed.cwd),
    cwd: parsed.cwd,
    version: "",
    timestamp: parsed.endTime || parsed.startTime || files[0].metadata.mtime.toISOString(),
    filePath: source.info?.filePath || source.paths[0],
    filePaths: source.paths,
    lineCount: files.reduce(
      (count, file) => count + file.text.split("\n").filter((line) => line.trim()).length,
      0,
    ),
    fileSize: files.reduce((bytes, file) => bytes + file.metadata.size, 0),
    firstPrompt: prompts[0] || "",
    prompts,
    promptCount: prompts.length,
    automationTriggerCount: replay.meta.stats.automationTriggerCount,
    toolCallCount: replay.meta.stats.toolCalls,
    compactionCount: parsed.compactions?.length || 0,
    model: parsed.model,
    gitBranch: parsed.gitBranch,
    gitRepo: parsed.gitRepo,
    hasSqlite: source.info?.hasSqlite || false,
    hasSdk: source.info?.hasSdk,
    sourceDatabasePath: source.info?.sourceDatabasePath,
  };
}

export function contentRevision(replay: ReplaySession): string {
  // Scene addresses depend on effective content, not parse time, local paths, or metadata.
  // JSON key ordering must not make a copied/reformatted replay a different revision.
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, stable(item)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          sessionId: replay.meta.sessionId,
          provider: replay.meta.provider,
          scenes: replay.scenes,
          annotations: replay.annotations || [],
        }),
      ),
    )
    .digest("hex");
}

function validateReplay(value: unknown): asserts value is ReplaySession {
  const replay = value as ReplaySession | undefined;
  if (
    !replay ||
    typeof replay.meta?.sessionId !== "string" ||
    !replay.meta.sessionId ||
    typeof replay.meta.provider !== "string" ||
    !Array.isArray(replay.scenes) ||
    replay.scenes.some(
      (scene) =>
        !scene ||
        typeof scene !== "object" ||
        (scene.type === "tool-call"
          ? typeof scene.toolName !== "string" ||
            !scene.input ||
            typeof scene.input !== "object" ||
            (scene.result !== undefined && typeof scene.result !== "string")
          : ![
              "user-prompt",
              "automation-trigger",
              "compaction-summary",
              "context-injection",
              "thinking",
              "text-response",
            ].includes(scene.type) ||
            !("content" in scene) ||
            typeof scene.content !== "string"),
    )
  )
    throw new Error("Invalid replay JSON: expected session metadata and valid scenes");
}

async function readStandaloneReplay(path: string): Promise<ReplaySession | undefined> {
  if (!existsSync(path) || !(await stat(path)).isFile()) return;
  const file = await open(path, "r");
  let head: string;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    head = buffer.toString("utf-8", 0, bytesRead);
  } finally {
    await file.close();
  }
  if (!/^\s*\{/.test(head) || (extname(path) !== ".json" && !/"(?:meta|scenes)"\s*:/.test(head)))
    return;
  const raw = await readFile(path, "utf-8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  } // Source JSONL and provider JSON continue through provider inference.
  if (!value || typeof value !== "object" || !("meta" in value) || !("scenes" in value)) return;
  validateReplay(value);
  return value;
}

function loadedSession(
  replay: ReplaySession,
  outputDir: string,
  publicationDir: string | undefined,
  origin: "source" | "snapshot",
  options: SessionReferenceOptions,
  discovery?: Awaited<ReturnType<typeof discoverCliSessions>>,
) {
  const revision = contentRevision(replay);
  if (options.revision !== undefined && options.revision !== revision)
    throw new Error(
      `Content revision mismatch: expected ${options.revision}, loaded ${revision}. Select --source or --snapshot, or inspect the exact exported JSON.`,
    );
  return {
    replay,
    outputDir,
    publicationDir,
    discovery,
    provenance: {
      origin,
      revision,
      sceneCount: replay.scenes.length,
      generator: replay.meta.generator
        ? {
            name: replay.meta.generator.name,
            version: replay.meta.generator.version,
            generatedAt: replay.meta.generator.generatedAt,
          }
        : undefined,
    },
  };
}

export async function readEffectiveReplay(outputDir: string): Promise<ReplaySession> {
  const replay = JSON.parse(
    await readFile(join(outputDir, "replay.json"), "utf-8"),
  ) as ReplaySession;
  validateReplay(replay);
  const overlays = await loadOverlays(dirname(outputDir), basename(outputDir), undefined, false);
  const annotations = await loadAnnotations(
    dirname(outputDir),
    basename(outputDir),
    undefined,
    false,
  );
  return sessionWithEffectiveContent(
    {
      ...replay,
      ...(annotations.length || existsSync(join(outputDir, "annotations.json"))
        ? { annotations }
        : {}),
    },
    overlays,
  );
}

async function findSavedReplay(ref: string, options: SessionReferenceOptions) {
  const base = join(homedir(), ".vibe-replay");
  const matches: { replay: ReplaySession; outputDir: string; publicationDir: string }[] = [];
  for (const slug of await readdir(base).catch(() => [] as string[])) {
    try {
      const replay = await readEffectiveReplay(join(base, slug));
      if (options.provider && replay.meta.provider !== options.provider) continue;
      if (
        options.target &&
        (replay.meta.location?.kind === "ssh" ? replay.meta.location.id : "local") !==
          options.target
      )
        continue;
      if (
        [replay.meta.sessionId, slug].some(
          (id) => id === ref || (ref.length >= 4 && id.startsWith(ref)),
        )
      )
        matches.push({ replay, outputDir: join(base, slug), publicationDir: join(base, slug) });
    } catch {
      /* Unrelated files are not replay references. */
    }
  }
  if (matches.length === 1)
    return loadedSession(
      matches[0].replay,
      matches[0].outputDir,
      matches[0].publicationDir,
      "snapshot",
      options,
    );
  if (matches.length > 1)
    throw new SessionReferenceError(
      "ambiguous",
      `Ambiguous saved replay reference '${ref}'; use its replay.json path`,
    );
}

export async function loadCliSession(
  ref: string,
  options: SessionReferenceOptions & { preferReplay?: boolean } = {},
) {
  if (options.source && options.snapshot) throw new Error("Use only one of --source or --snapshot");
  const preferReplay = options.snapshot || (!options.source && options.preferReplay);
  const path = resolve(expandUserPath(ref));
  const replayDir = existsSync(join(path, "replay.json"))
    ? path
    : basename(path) === "replay.json" && existsSync(path)
      ? dirname(path)
      : undefined;
  const standalone = replayDir ? undefined : await readStandaloneReplay(path);
  if (replayDir || standalone) {
    if (options.source)
      throw new Error("--source requires a source session reference, not a replay JSON");
    const replay = standalone || (await readEffectiveReplay(replayDir!));
    if (options.provider && replay.meta.provider !== options.provider)
      throw new Error(`Replay provider is '${replay.meta.provider}', not '${options.provider}'`);
    const target = replay.meta.location?.kind === "ssh" ? replay.meta.location.id : "local";
    if (options.target && target !== options.target)
      throw new Error(`Replay belongs to target '${target}', not '${options.target}'`);
    // Standalone handoffs never inherit another replay's directory sidecars or publication URL.
    return loadedSession(replay, replayDir || dirname(path), replayDir, "snapshot", options);
  }
  if (options.snapshot && !pathExists(ref)) {
    const saved = await findSavedReplay(ref, options);
    if (saved) return saved;
  }
  let source: Awaited<ReturnType<typeof resolveCliSource>>;
  try {
    source = await resolveCliSource(ref, options);
  } catch (error) {
    if (options.source || !(error instanceof SessionReferenceError) || error.code !== "not-found")
      throw error;
    const saved = await findSavedReplay(ref, options);
    if (saved) return saved;
    throw error;
  }
  if (preferReplay && (options.snapshot || !pathExists(ref)) && source.info) {
    const info = source.info;
    const ids = [...new Set([info.sessionId, ...(info.sessionIds || [])])];
    const exactId = ids.find((id) => id === ref);
    const prefixIds = ref.length >= 4 ? ids.filter((id) => id.startsWith(ref)) : [];
    const requestedId = exactId || (prefixIds.length === 1 ? prefixIds[0] : undefined);
    const candidates = [...new Set([...(requestedId ? [requestedId] : []), ...ids])];
    const savedDirs = new Set(
      candidates.map((sessionId) =>
        join(
          homedir(),
          ".vibe-replay",
          replayOutputSlug(info.slug || sessionId.slice(0, 8), info.location, {
            provider: source.provider,
            sessionId,
          }),
        ),
      ),
    );
    for (const savedDir of savedDirs) {
      if (!existsSync(join(savedDir, "replay.json"))) continue;
      const existing = await readEffectiveReplay(savedDir);
      const savedTarget =
        existing.meta.location?.kind === "ssh" ? existing.meta.location.id : "local";
      const sourceTarget = info.location?.kind === "ssh" ? info.location.id : "local";
      if (
        [info.sessionId, ...(info.sessionIds || [])].includes(existing.meta.sessionId) &&
        existing.meta.provider === source.provider &&
        savedTarget === sourceTarget
      ) {
        if ((!existing.meta.title || existing.meta.title === existing.meta.slug) && info.title)
          existing.meta.title = info.title;
        return loadedSession(existing, savedDir, savedDir, "snapshot", options, source.discovery);
      }
    }
  }
  if (options.snapshot)
    throw new Error(
      "No saved snapshot found; pass its replay JSON path or generate a replay first",
    );
  if (source.info?.transcriptStatus)
    throw new Error(
      source.info.hasSdk && source.info.sourceDatabasePath
        ? "The SDK database has no companion transcript with user prompts. Copy the agent's JSONL transcript beside the supplied database."
        : `Session transcript is ${source.info.transcriptStatus}`,
    );
  if (source.info?.location?.kind === "ssh") await hydrateCachedRemoteHomes();
  const parsed = await withReadOnlySqlite(!!options.readOnly, () =>
    getProvider(source.provider)!.parse(source.paths, source.info),
  );
  const replay = transformToReplay(
    parsed,
    source.provider,
    shortenPath(source.info?.project || parsed.cwd),
    {
      location: source.info?.location,
      remoteHome: getRemoteHome(
        source.info?.location?.kind === "ssh" ? source.info.location.id : undefined,
      ),
      generator: {
        name: "vibe-replay",
        version: CLI_VERSION,
        generatedAt: new Date().toISOString(),
      },
    },
  );
  if (!hasReplayableContent(replay)) throw new Error("This session has no replayable user prompts");
  if (source.info?.title) replay.meta.title = source.info.title;
  const slug = replayOutputSlug(
    replay.meta.slug || replay.meta.sessionId.slice(0, 8),
    source.info?.location,
    { provider: source.provider, sessionId: replay.meta.sessionId },
  );
  const outputDir = join(homedir(), ".vibe-replay", slug);
  return loadedSession(replay, outputDir, undefined, "source", options, source.discovery);
}

function excerptDetails(text: string, max: number, query?: string, offset?: number) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : 0;
  const start = offset ?? Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(text.length, start + max);
  return {
    value: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    truncated: start > 0 || end < text.length,
    length: text.length,
    offset: start,
    end,
    nextOffset: end < text.length ? end : undefined,
  };
}

function excerpt(text: string, max: number, query?: string): string {
  return excerptDetails(text, max, query).value;
}

function sceneText(scene: Scene): string {
  if (scene.type === "tool-call")
    return `${scene.toolName}\n${JSON.stringify(scene.input)}\n${scene.result || ""}`;
  return "content" in scene && typeof scene.content === "string"
    ? scene.content
    : JSON.stringify(scene);
}

export function inspectSession(
  replay: ReplaySession,
  options: {
    query?: string;
    scene?: number;
    offset?: number;
    limit?: number;
    field?: "text" | "input" | "result";
    textOffset?: number;
    textLimit?: number;
  } = {},
) {
  const limit = options.limit ?? 12;
  const content =
    options.query !== undefined || options.scene !== undefined || options.offset !== undefined;
  const query = options.query?.trim();
  const indexed = replay.scenes.map((scene, index) => ({ scene, index }));
  const eligible = indexed.slice(options.offset || 0);
  const matches =
    options.scene !== undefined
      ? indexed.filter((s) => s.index === options.scene)
      : query
        ? eligible.filter((s) => sceneText(s.scene).toLowerCase().includes(query.toLowerCase()))
        : eligible;
  const scenes = matches.slice(0, limit).map(({ scene, index }) => {
    const field = options.field || "text";
    if (field !== "text" && scene.type !== "tool-call")
      throw new Error(`Scene ${index} has no ${field} field; use --field text`);
    const values = {
      text: sceneText(scene),
      ...(scene.type === "tool-call"
        ? {
            input: JSON.stringify(scene.input),
            result: scene.result || "",
          }
        : {}),
    };
    const paging =
      options.textOffset !== undefined ||
      options.textLimit !== undefined ||
      options.field !== undefined;
    const selected = values[field];
    if (selected === undefined) throw new Error(`Scene ${index} has no ${field} field`);
    if (paging && (options.textOffset || 0) > selected.length)
      throw new Error(`--text-offset must be at most ${selected.length}`);
    const windows = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        excerptDetails(
          value,
          paging && key === field ? (options.textLimit ?? 2000) : key === "input" ? 1000 : 2000,
          paging && key === field ? undefined : query,
          paging && key === field ? (options.textOffset ?? 0) : undefined,
        ),
      ]),
    );
    return {
      index,
      type: scene.type,
      timestamp: scene.timestamp,
      text: windows.text.value,
      textTruncated: windows.text.truncated,
      fields: Object.fromEntries(
        Object.entries(windows).map(([key, { value: _value, ...info }]) => [key, info]),
      ),
      ...(paging
        ? {
            content: {
              field,
              ...windows[field],
              value: selected.slice(windows[field].offset, windows[field].end),
            },
          }
        : {}),
      ...(scene.type === "tool-call"
        ? {
            toolName: scene.toolName,
            isError: scene.isError,
            hasResult: scene.hasResult,
            input: windows.input.value,
            result: windows.result.value,
            inputTruncated: windows.input.truncated,
            resultTruncated: windows.result.truncated,
          }
        : {}),
    };
  });
  const tools: Record<string, number> = {};
  for (const scene of replay.scenes)
    if (scene.type === "tool-call" && !scene.isToolContainer)
      tools[scene.toolName] = (tools[scene.toolName] || 0) + 1;
  if (!replay.meta.stats)
    throw new Error(
      "Cannot inspect this legacy replay: missing stats; regenerate it from its source session",
    );
  const { turnStats, ...stats } = replay.meta.stats;
  const responses = indexed.filter((s) => s.scene.type === "text-response");
  return {
    revision: contentRevision(replay),
    sessionId: replay.meta.sessionId,
    slug: replay.meta.slug,
    title: replay.meta.title,
    provider: replay.meta.provider,
    location: replay.meta.location,
    project: replay.meta.project,
    startTime: replay.meta.startTime,
    endTime: replay.meta.endTime,
    stats,
    prLinks: replay.meta.prLinks,
    toolCounts: tools,
    parseWarnings: replay.meta.parseWarnings,
    diagnosticNotes: replay.meta.diagnosticNotes,
    ...(content
      ? {
          query,
          matchCount: matches.length,
          scenes,
          truncated: matches.length > scenes.length,
          nextOffset: matches.length > scenes.length ? scenes.at(-1)!.index + 1 : undefined,
        }
      : {
          prompts: indexed
            .filter((s) => s.scene.type === "user-prompt")
            .slice(0, limit)
            .map(({ scene, index }) => ({ index, text: excerpt(sceneText(scene), 500) })),
          lastResponse: responses.length
            ? {
                index: responses.at(-1)!.index,
                text: excerpt(sceneText(responses.at(-1)!.scene), 1200),
              }
            : undefined,
          turnStats: turnStats?.slice(0, 80),
          turnStatsTruncated: (turnStats?.length || 0) > 80,
        }),
  };
}

export function diagnoseSession(replay: ReplaySession, query?: string, limit = 12) {
  const toolErrors = replay.scenes.flatMap((scene, index) =>
    scene.type === "tool-call" && scene.isError && !scene.isToolContainer
      ? [
          {
            index,
            tool: scene.toolName,
            timestamp: scene.timestamp,
            text: excerpt(sceneText(scene), 1000),
          },
        ]
      : [],
  );
  return {
    revision: contentRevision(replay),
    sessionId: replay.meta.sessionId,
    title: replay.meta.title,
    apiErrorCount: replay.meta.apiErrors?.length || 0,
    apiErrors: replay.meta.apiErrors?.slice(0, limit) || [],
    toolErrorCount: toolErrors.length,
    toolErrors: toolErrors.slice(0, limit),
    compactionCount: replay.meta.compactions?.length || 0,
    compactions: replay.meta.compactions?.slice(0, limit) || [],
    diagnostics: replay.meta.diagnostics?.slice(0, limit) || [],
    parseWarnings: replay.meta.parseWarnings || [],
    notes: [
      "API errors, tool failures, and recorded compactions are separate signals; zero API errors does not mean a build succeeded.",
      "Error text in a successful tool result is searchable evidence, not automatically a failed invocation or a root-cause conclusion.",
      ...(replay.meta.diagnosticNotes || []),
    ],
    ...(query ? { evidence: inspectSession(replay, { query, limit }) } : {}),
  };
}

export function sharePreflight(replay: ReplaySession, visibility: string, loggedIn: boolean) {
  const shareable = sessionForExternalOutput(replay);
  const payload = JSON.stringify(shareable);
  const sizeBytes = Buffer.byteLength(payload);
  const findings = scanForSecrets(payload).map(({ rule }) => ({ rule }));
  return {
    sessionId: replay.meta.sessionId,
    title: replay.meta.title,
    visibility,
    mode: loggedIn ? "cloud" : "local-fallback",
    sizeBytes,
    maxCloudBytes: 10 * 1024 * 1024,
    withinCloudLimit: sizeBytes <= 10 * 1024 * 1024,
    potentialSecretCount: findings.length,
    findings,
    uploaded: false,
  };
}

export async function exportText(
  replay: ReplaySession,
  publicationDir: string | undefined,
  format: string,
): Promise<string> {
  const shareable = sessionForExternalOutput(replay);
  if (!["markdown", "json", "html"].includes(format))
    throw new Error("--format must be markdown, json, or html");
  const savedCloud =
    publicationDir && format === "markdown" ? await loadSavedCloudInfo(publicationDir) : undefined;
  const savedGist =
    publicationDir && format === "markdown" ? await loadSavedGistInfo(publicationDir) : undefined;
  const replayUrl =
    savedCloud && Date.parse(savedCloud.expiresAt) > Date.now()
      ? savedCloud.url
      : savedGist?.viewerUrl;
  return format === "markdown"
    ? generateGitHubMarkdown(shareable, { replayUrl })
    : JSON.stringify(shareable);
}

export async function exportSession(
  replay: ReplaySession,
  outputDir: string,
  format: string,
  replayDirectory?: string,
) {
  const shareable = sessionForExternalOutput(replay);
  const text = await exportText(shareable, replayDirectory, format);
  await mkdir(outputDir, { recursive: true });
  const path =
    format === "html"
      ? await generateOutput(shareable, outputDir)
      : join(outputDir, format === "markdown" ? "github-summary.md" : "replay.json");
  if (format !== "html") await writeFile(path, `${text}\n`, "utf-8");
  const report = {
    version: 1,
    source: basename(path),
    alreadyRedactedCount: (text.match(/\[REDACTED\]/g) || []).length,
    leftoverFindings: scanForSecrets(text),
  };
  const redactionsPath = join(outputDir, "redactions.json");
  await writeFile(redactionsPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return { path, redactionsPath, potentialSecretCount: report.leftoverFindings.length, format };
}
