import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { normalizeGitUrl } from "@vibe-replay/provider-core/utils";
import { discoverClaudeCodeSessions } from "@vibe-replay/provider-claude-code/claude-code/discover";
import {
  discoverCodexSessions,
  mergeCodexSessionMetadata,
  readCodexSessionIndex,
  type CodexSessionMetadata,
} from "@vibe-replay/provider-codex/discover";
import {
  CODEX_REMOTE_METADATA_SCRIPT,
  parseCodexRemoteMetadata,
  type RemoteCodexMetadataResult,
} from "@vibe-replay/provider-codex/remote";
import { discoverPiSessions } from "@vibe-replay/provider-pi/discover";
import type { SessionInfo, SessionLocation } from "./types.js";

const DEFAULT_REMOTE_PROVIDERS = ["claude-code", "codex", "pi"] as const;
const REMOTE_CACHE_VERSION = 2;
const REMOTE_CACHE_ROOT = join(homedir(), ".vibe-replay", "remote-sources");
const DEFAULT_CONFIG_PATH = join(homedir(), ".vibe-replay", "config.json");
const FALLBACK_CONFIG_PATH = join(homedir(), ".config", "vibe-replay", "config.json");
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONNECT_TIMEOUT_MS = 60_000;
const MIN_REMOTE_OPERATION_TIMEOUT_MS = 2 * 60_000;
const MAX_CODEX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_REMOTE_INDEX_BYTES = 2 * 1024 * 1024 * 1024;
const REMOTE_CACHE_LOCK_TIMEOUT_MS = 2 * 60_000;
const REMOTE_CACHE_LOCK_STALE_MS = 30 * 60_000;

/**
 * A configured SSH endpoint. Authentication is intentionally not part of this
 * shape: OpenSSH reads keys, agents, ProxyJump, ProxyCommand, and host aliases
 * from the user's normal SSH configuration.
 */
export interface RemoteSourceConfig {
  id: string;
  sshHost: string;
  label: string;
  providers: string[];
  connectTimeoutMs: number;
}

export interface RemoteDiscoveryOptions {
  /** Override the normal config lookup, primarily for callers and tests. */
  configPath?: string;
  /** Override the persistent cache root, primarily for isolated callers/tests. */
  cacheRoot?: string;
}

interface RemoteFileEntry {
  provider: (typeof DEFAULT_REMOTE_PROVIDERS)[number];
  remotePath: string;
  relativePath: string;
  archivePath?: string;
  size: number;
  mtimeMs: number;
}

interface RemoteIndex {
  home: string;
  files: RemoteFileEntry[];
}

interface RemoteCacheManifest {
  version: number;
  home?: string;
  entries: Record<
    string,
    {
      remotePath: string;
      size: number;
      mtimeMs: number;
    }
  >;
  codexMetadata: Record<string, CodexSessionMetadata>;
  gitRepos: Record<string, string>;
}

interface RemoteDiscoveryResult {
  sessions: SessionInfo[];
  failed: boolean;
}

const REMOTE_DISCOVERY_SCRIPT = `#!/bin/sh
if ! command -v find >/dev/null 2>&1 ||
   ! command -v wc >/dev/null 2>&1 ||
   ! command -v tr >/dev/null 2>&1 ||
   ! command -v mktemp >/dev/null 2>&1 ||
   ! command -v rm >/dev/null 2>&1; then
  exit 1
fi
home=\${HOME:-}
if [ -z "$home" ]; then
  home=$(pwd)
fi

printf 'protocol\\t2\\n'
printf 'home\\t%s\\n' "$home"

emit_files() {
  provider=$1
  root=$2
  logical_root=$3
  [ -d "$root" ] || return 0

  list=$(mktemp "\${TMPDIR:-/tmp}/vibe-replay-index.XXXXXX") || return 1
  if ! find "$root" -type f -name '*.jsonl' -print > "$list" 2>/dev/null; then
    rm -f "$list"
    return 1
  fi

  while IFS= read -r file; do
    size=$(wc -c < "$file" 2>/dev/null) || {
      rm -f "$list"
      return 1
    }
    size=$(printf '%s' "$size" | tr -d '[:space:]')
    case "$size" in
      ''|*[!0-9]*)
        rm -f "$list"
        return 1
        ;;
    esac

    mtime=$(stat -c %Y "$file" 2>/dev/null)
    if [ -z "$mtime" ]; then
      mtime=$(stat -f %m "$file" 2>/dev/null)
    fi
    case "$mtime" in
      ''|*[!0-9]*)
        rm -f "$list"
        return 1
        ;;
    esac

    relative=\${file#"$root"/}
    relative="$logical_root/$relative"
    archive_path=
    case "$file" in
      "$home"/*) archive_path=\${file#"$home"/} ;;
    esac
    tab=$(printf '\\t')
    case "$file$relative$archive_path" in
      *"$tab"*) continue ;;
    esac
    printf 'file\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \
      "$provider" "$file" "$relative" "$size" "$mtime" "$archive_path"
  done < "$list"
  rm -f "$list"
}

emit_file() {
  provider=$1
  file=$2
  relative=$3
  [ -f "$file" ] || return 0

  size=$(wc -c < "$file" 2>/dev/null) || return 1
  size=$(printf '%s' "$size" | tr -d '[:space:]')
  case "$size" in
    ''|*[!0-9]*) return 1 ;;
  esac

  mtime=$(stat -c %Y "$file" 2>/dev/null)
  if [ -z "$mtime" ]; then
    mtime=$(stat -f %m "$file" 2>/dev/null)
  fi
  case "$mtime" in
    ''|*[!0-9]*) return 1 ;;
  esac

  archive_path=
  case "$file" in
    "$home"/*) archive_path=\${file#"$home"/} ;;
  esac
  printf 'file\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \
    "$provider" "$file" "$relative" "$size" "$mtime" "$archive_path"
}

claude_home=\${CLAUDE_CONFIG_DIR:-"$home/.claude"}
codex_home=\${CODEX_HOME:-"$home/.codex"}
pi_agent_home=\${PI_CODING_AGENT_DIR:-"$home/.pi/agent"}
pi_sessions_root=\${PI_CODING_AGENT_SESSION_DIR:-"$pi_agent_home/sessions"}

emit_files claude-code "$claude_home/projects" ".claude/projects" || exit 1
emit_files codex "$codex_home/sessions" ".codex/sessions" || exit 1
emit_file codex "$codex_home/session_index.jsonl" ".codex/session_index.jsonl" || exit 1
emit_files pi "$pi_sessions_root" ".pi/agent/sessions" || exit 1
printf 'complete\\n'
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSafeConfigId(value: string): boolean {
  return value !== "local" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function isSafeSshHost(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("-") &&
    !/\s/.test(value) &&
    !value.includes(String.fromCharCode(0))
  );
}

function parseRemoteSource(raw: unknown): RemoteSourceConfig | null {
  if (!isRecord(raw)) return null;

  const id = nonEmptyString(raw.id);
  const sshHost = nonEmptyString(raw.sshHost);
  if (!id || !isSafeConfigId(id) || !sshHost || !isSafeSshHost(sshHost)) return null;

  const labelValue = nonEmptyString(raw.label);
  const providers = Array.isArray(raw.providers)
    ? raw.providers.filter(
        (value): value is (typeof DEFAULT_REMOTE_PROVIDERS)[number] =>
          typeof value === "string" &&
          DEFAULT_REMOTE_PROVIDERS.includes(value as (typeof DEFAULT_REMOTE_PROVIDERS)[number]),
      )
    : [...DEFAULT_REMOTE_PROVIDERS];
  const timeoutValue = raw.connectTimeoutMs;
  const connectTimeoutMs =
    typeof timeoutValue === "number" && Number.isFinite(timeoutValue)
      ? Math.max(1_000, Math.min(MAX_CONNECT_TIMEOUT_MS, Math.round(timeoutValue)))
      : DEFAULT_CONNECT_TIMEOUT_MS;

  return {
    id,
    sshHost,
    label: labelValue || `SSH · ${id}`,
    providers: [...new Set(providers)],
    connectTimeoutMs,
  };
}

/** Parse the JSON value from a config file without performing I/O. */
export function parseRemoteSourceConfig(value: unknown): RemoteSourceConfig[] {
  if (!isRecord(value) || !Array.isArray(value.remoteSources)) return [];

  const seen = new Set<string>();
  const targets: RemoteSourceConfig[] = [];
  for (const raw of value.remoteSources) {
    const target = parseRemoteSource(raw);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    targets.push(target);
  }
  return targets;
}

/** Load configured SSH targets. A missing config is the normal zero-config case. */
export async function loadRemoteSourceConfigs(configPath?: string): Promise<RemoteSourceConfig[]> {
  const configuredPath = configPath || process.env.VIBE_REPLAY_CONFIG;
  const candidates = configuredPath
    ? [configuredPath]
    : [DEFAULT_CONFIG_PATH, FALLBACK_CONFIG_PATH];

  for (const candidate of candidates) {
    let content: string;
    try {
      content = await readFile(candidate, "utf-8");
    } catch {
      continue;
    }

    try {
      return parseRemoteSourceConfig(JSON.parse(content));
    } catch {
      if (process.env.VIBE_REPLAY_DEBUG) {
        console.error("[vibe-replay] SSH source config could not be parsed");
      }
      return [];
    }
  }

  return [];
}

function targetLocation(target: RemoteSourceConfig): SessionLocation {
  return {
    kind: "ssh",
    id: target.id,
    label: target.label,
  };
}

function cacheRootForTarget(target: RemoteSourceConfig, cacheRoot = REMOTE_CACHE_ROOT): string {
  // Bind persisted bytes to both the stable location id and the actual SSH
  // endpoint. Repointing an id must never make a new host inherit the old
  // host's transcripts merely because size/mtime happen to match.
  const key = createHash("sha256")
    .update(`${target.id}\0${target.sshHost}`)
    .digest("hex")
    .slice(0, 20);
  return join(cacheRoot, key);
}

function manifestPathForCache(cacheRoot: string): string {
  return join(cacheRoot, ".manifest.json");
}

function safeRelativePath(relativePath: string): string | null {
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.includes("\r") ||
    relativePath.includes("\n") ||
    relativePath.includes("\t") ||
    posix.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    return null;
  }
  const rawParts = relativePath.split("/");
  if (rawParts.some((part) => part === "" || part === "." || part === "..")) return null;
  const normalized = posix.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}

function providerForRemoteCachePath(
  relativePath: string,
): (typeof DEFAULT_REMOTE_PROVIDERS)[number] | undefined {
  if (relativePath.startsWith(".claude/projects/")) return "claude-code";
  if (
    relativePath.startsWith(".codex/sessions/") ||
    relativePath === ".codex/session_index.jsonl"
  ) {
    return "codex";
  }
  if (relativePath.startsWith(".pi/agent/sessions/")) return "pi";
  return undefined;
}

/**
 * Keep providers outside a scoped refresh untouched. Generation may discover
 * only one provider, while the same target cache also contains other providers.
 */
function preservedRemoteEntries(
  entries: RemoteCacheManifest["entries"],
  refreshedProviders: ReadonlySet<string>,
): RemoteCacheManifest["entries"] {
  return Object.fromEntries(
    Object.entries(entries).filter(([relativePath]) => {
      const provider = providerForRemoteCachePath(relativePath);
      return !provider || !refreshedProviders.has(provider);
    }),
  );
}

export const __testables = {
  acquireRemoteCacheLock,
  cacheRootForTarget,
  classifyRemoteCacheLockFailure,
  inspectCachedPath,
  parseRemoteCodexMetadata: parseCodexRemoteMetadata,
  parseRemoteGitMetadata,
  parseRemoteIndex,
  preservedRemoteEntries,
  safeRelativePath,
};

function localPathForRemoteFile(cacheRoot: string, relativePath: string): string | null {
  const safePath = safeRelativePath(relativePath);
  if (!safePath) return null;
  return join(cacheRoot, ...safePath.split("/"));
}

type CachedPathInspection =
  | { status: "missing" }
  | { status: "file"; size: number }
  | { status: "unsafe" };

async function inspectCachedPath(
  cacheRoot: string,
  relativePath: string,
): Promise<CachedPathInspection> {
  const safePath = safeRelativePath(relativePath);
  if (!safePath) return { status: "unsafe" };
  const rootEntry = await lstat(cacheRoot).catch(() => null);
  if (!rootEntry) return { status: "missing" };
  if (!rootEntry.isDirectory()) return { status: "unsafe" };
  const parts = safePath.split("/");
  let current = cacheRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const entry = await lstat(current).catch(() => null);
    if (!entry) return { status: "missing" };
    if (index === parts.length - 1) {
      return entry.isFile() ? { status: "file", size: entry.size } : { status: "unsafe" };
    }
    if (!entry.isDirectory()) return { status: "unsafe" };
  }
  return { status: "missing" };
}

async function ensureSafeCacheRoot(cacheRoot: string): Promise<void> {
  await mkdir(dirname(cacheRoot), { recursive: true });
  const existing = await lstat(cacheRoot).catch(() => null);
  if (existing && !existing.isDirectory()) {
    throw new Error("Remote cache root is not a directory");
  }
  if (!existing) await mkdir(cacheRoot);
  const verified = await lstat(cacheRoot).catch(() => null);
  if (!verified?.isDirectory()) throw new Error("Remote cache root is unsafe");
  await chmod(cacheRoot, 0o700).catch(() => {});
}

async function isStaleRemoteCacheLock(
  lockPath: string,
  mtimeMs: number,
  staleMs: number,
): Promise<boolean> {
  const owner = await readFile(lockPath, "utf-8").catch(() => "");
  const pid = Number.parseInt(owner.trim(), 10);
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      // A lock held by a dead process is safe to reclaim immediately. Waiting
      // for the full stale interval made an interrupted dashboard block every
      // subsequent remote refresh for up to 30 minutes.
      return (error as NodeJS.ErrnoException).code !== "EPERM";
    }
  }

  // Keep malformed or partially-written locks conservative until they have
  // aged out; the owner may be between creating the file and writing its PID.
  return Date.now() - mtimeMs > staleMs;
}

/**
 * Reclaim a stale lock without unlinking a newer owner's lock.
 *
 * Renaming the stale lock out of the well-known path is the atomic hand-off:
 * another process can acquire `lockPath` after the rename, while this process
 * only removes the exact directory entry it moved.
 */
async function reclaimStaleRemoteCacheLock(lockPath: string): Promise<boolean> {
  const reclaimedPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, reclaimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await unlink(reclaimedPath);
  return true;
}

async function acquireRemoteCacheLock(
  cacheRoot: string,
  timeoutMs = REMOTE_CACHE_LOCK_TIMEOUT_MS,
  staleMs = REMOTE_CACHE_LOCK_STALE_MS,
): Promise<() => Promise<void>> {
  await mkdir(dirname(cacheRoot), { recursive: true });
  const lockPath = `${cacheRoot}.lock`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const ownerToken = `${process.pid}:${randomUUID()}`;
      try {
        await handle.writeFile(`${ownerToken}\n`, "utf-8");
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }

      return async () => {
        const owner = await readFile(lockPath, "utf-8").catch(() => "");
        await handle.close().catch(() => {});
        if (owner.trim() === ownerToken) {
          await unlink(lockPath).catch(() => {});
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockEntry = await lstat(lockPath).catch(() => null);
      if (lockEntry?.isSymbolicLink()) {
        throw new Error("Remote cache lock is unsafe", { cause: error });
      }
      const lockStat = lockEntry ? await stat(lockPath).catch(() => null) : null;
      if (!lockStat || (await isStaleRemoteCacheLock(lockPath, lockStat.mtimeMs, staleMs))) {
        if (lockStat) {
          await reclaimStaleRemoteCacheLock(lockPath).catch((reclaimError) => {
            if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError;
          });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Remote cache is busy", { cause: error });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sshTimeoutMs(target: RemoteSourceConfig): number {
  // The same SSH process streams the discovery index and, on a cold cache,
  // the remote transcript batch. A 15s floor is enough for a probe but not
  // for a legitimate multi-hundred-megabyte first sync.
  return Math.max(target.connectTimeoutMs + 5_000, MIN_REMOTE_OPERATION_TIMEOUT_MS);
}

function spawnSsh(target: RemoteSourceConfig, command: string[]): ChildProcess {
  return spawn(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "LogLevel=ERROR",
      "-o",
      `ConnectTimeout=${Math.ceil(target.connectTimeoutMs / 1_000)}`,
      target.sshHost,
      ...command,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

function runSsh(
  target: RemoteSourceConfig,
  command: string[],
  input: string,
  maxOutputBytes = 16 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnSsh(target, command);
    if (!child.stdout || !child.stderr || !child.stdin) {
      child.kill();
      reject(new Error("SSH process could not be started"));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, sshTimeoutMs(target));

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(new Error("SSH discovery response was too large"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => fail(new Error("OpenSSH client unavailable")));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || timedOut) {
        reject(new Error(timedOut ? "SSH command timed out" : "SSH command failed"));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });

    child.stdin.end(input);
  });
}

function parseRemoteIndex(output: Buffer): RemoteIndex {
  let home = "";
  let protocolVersion: number | undefined;
  let complete = false;
  let totalBytes = 0;
  const files: RemoteFileEntry[] = [];
  const validProviders = new Set<string>(DEFAULT_REMOTE_PROVIDERS);

  for (const line of output.toString("utf-8").split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields[0] === "protocol") {
      protocolVersion = Number(fields[1]);
      continue;
    }
    if (fields[0] === "complete") {
      complete = true;
      continue;
    }
    if (fields[0] === "home") {
      home = fields.slice(1).join("\t");
      continue;
    }
    if (fields[0] !== "file" || fields.length < 6 || !validProviders.has(fields[1])) continue;

    const relativePath = safeRelativePath(fields[3]);
    const archiveField = fields.length >= 7 ? fields[6] : fields[3];
    const archivePath = archiveField ? safeRelativePath(archiveField) : null;
    const size = Number(fields[4]);
    const mtimeSeconds = Number(fields[5]);
    const remotePath = fields[2];
    if (
      !relativePath ||
      (archiveField && !archivePath) ||
      !remotePath ||
      remotePath.includes("\r") ||
      remotePath.includes("\n") ||
      remotePath.includes("\t") ||
      remotePath.includes("\0") ||
      remotePath.includes("\0") ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      continue;
    }
    if (size > MAX_REMOTE_FILE_BYTES) {
      throw new Error("Remote session file exceeds the transfer limit");
    }
    totalBytes += size;
    if (totalBytes > MAX_REMOTE_INDEX_BYTES) {
      throw new Error("Remote session index exceeds the transfer limit");
    }

    files.push({
      provider: fields[1] as RemoteFileEntry["provider"],
      remotePath,
      relativePath,
      ...(archivePath ? { archivePath } : {}),
      size,
      mtimeMs:
        Number.isFinite(mtimeSeconds) && mtimeSeconds > 0 ? Math.round(mtimeSeconds * 1_000) : 0,
    });
  }

  if (protocolVersion === 2 && !complete) {
    throw new Error("Remote session index was incomplete");
  }
  return { home, files };
}

function emptyRemoteCacheManifest(): RemoteCacheManifest {
  return {
    version: REMOTE_CACHE_VERSION,
    entries: {},
    codexMetadata: {},
    gitRepos: {},
  };
}

function parseCachedCodexMetadata(value: unknown): Record<string, CodexSessionMetadata> {
  if (!isRecord(value)) return {};
  const metadata: Record<string, CodexSessionMetadata> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const sessionId = nonEmptyString(raw.sessionId) || nonEmptyString(key);
    if (!sessionId) continue;

    const entry: CodexSessionMetadata = { sessionId };
    const stringFields = [
      "rolloutPath",
      "cwd",
      "title",
      "threadName",
      "gitBranch",
      "cliVersion",
      "firstUserMessage",
      "model",
    ] as const;
    for (const field of stringFields) {
      const fieldValue = nonEmptyString(raw[field]);
      if (fieldValue) entry[field] = fieldValue;
    }
    const dateFields = ["createdAt", "updatedAt"] as const;
    for (const field of dateFields) {
      const fieldValue = raw[field];
      if (
        (typeof fieldValue === "string" && fieldValue.trim()) ||
        (typeof fieldValue === "number" && Number.isFinite(fieldValue))
      ) {
        entry[field] = fieldValue;
      }
    }
    const numberFields = ["createdAtMs", "updatedAtMs"] as const;
    for (const field of numberFields) {
      const fieldValue = raw[field];
      if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
        entry[field] = fieldValue;
      }
    }
    metadata[sessionId] = entry;
  }
  return metadata;
}

function parseCachedGitRepos(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const repos: Record<string, string> = {};
  for (const [key, repo] of Object.entries(value)) {
    if (key.length > 0 && typeof repo === "string") {
      repos[key] = repo;
    }
  }
  return repos;
}

function metadataTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === "number") {
    const millis = value < 1_577_836_800_000 ? value * 1_000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return metadataTimestamp(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function metadataOnlyCodexSession(metadata: CodexSessionMetadata): SessionInfo {
  const cwd = metadata.cwd || "";
  return {
    provider: "codex",
    sessionId: metadata.sessionId,
    slug: metadata.sessionId.slice(0, 8),
    title: metadata.threadName || metadata.title,
    project: cwd,
    cwd,
    version: metadata.cliVersion || "",
    gitBranch: metadata.gitBranch,
    timestamp:
      metadataTimestamp(metadata.updatedAtMs) ||
      metadataTimestamp(metadata.updatedAt) ||
      metadataTimestamp(metadata.createdAtMs) ||
      metadataTimestamp(metadata.createdAt) ||
      new Date(0).toISOString(),
    lineCount: 0,
    fileSize: 0,
    filePath: "",
    filePaths: [],
    firstPrompt: "",
    promptCount: 0,
    model: metadata.model,
    transcriptStatus: "unreadable",
  };
}

function unavailableRemoteFileSession(file: RemoteFileEntry): SessionInfo {
  const slug =
    `${file.provider}-${file.relativePath}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(-80) ||
    "unreadable";
  return {
    provider: file.provider,
    sessionId: `${file.provider}:${file.relativePath}`,
    slug,
    project: "",
    cwd: "",
    version: "",
    timestamp: file.mtimeMs > 0 ? new Date(file.mtimeMs).toISOString() : new Date(0).toISOString(),
    lineCount: 0,
    fileSize: file.size,
    filePath: "",
    filePaths: [],
    firstPrompt: "",
    promptCount: 0,
    transcriptStatus: "unreadable",
  };
}

function isRemoteTranscriptFile(file: RemoteFileEntry): boolean {
  return file.relativePath !== ".codex/session_index.jsonl";
}

function unavailableRemoteSessions(
  index: RemoteIndex,
  cachedSessions: SessionInfo[],
  codexMetadata: ReadonlyMap<string, CodexSessionMetadata>,
  cacheRoot: string,
): SessionInfo[] {
  const sessions = [...cachedSessions];
  const knownIds = new Set(sessions.map((session) => `${session.provider}::${session.sessionId}`));
  const knownPaths = new Set(sessions.flatMap((session) => session.filePaths));
  const add = (session: SessionInfo): void => {
    const key = `${session.provider}::${session.sessionId}`;
    if (knownIds.has(key)) return;
    knownIds.add(key);
    sessions.push(session);
  };

  for (const metadata of codexMetadata.values()) {
    const existingIndex = sessions.findIndex(
      (session) => session.provider === "codex" && session.sessionId === metadata.sessionId,
    );
    if (existingIndex >= 0) {
      sessions[existingIndex] = mergeCodexSessionMetadata(sessions[existingIndex], metadata);
    } else {
      add(metadataOnlyCodexSession(metadata));
    }
  }
  for (const file of index.files) {
    if (!isRemoteTranscriptFile(file)) continue;
    const localPath = localPathForRemoteFile(cacheRoot, file.relativePath);
    if (localPath && knownPaths.has(localPath)) continue;
    const metadata =
      file.provider === "codex"
        ? [...codexMetadata.values()].find((entry) => entry.rolloutPath === file.remotePath)
        : undefined;
    add(metadata ? metadataOnlyCodexSession(metadata) : unavailableRemoteFileSession(file));
  }
  return sessions;
}

function addMissingRemoteFileSessions(
  index: RemoteIndex,
  sessions: SessionInfo[],
  codexMetadata: ReadonlyMap<string, CodexSessionMetadata>,
  cacheRoot: string,
): SessionInfo[] {
  const result = [...sessions];
  const knownIds = new Set(result.map((session) => `${session.provider}::${session.sessionId}`));
  const knownPaths = new Set(result.flatMap((session) => session.filePaths));
  const add = (session: SessionInfo): void => {
    const idKey = `${session.provider}::${session.sessionId}`;
    if (knownIds.has(idKey)) return;
    knownIds.add(idKey);
    result.push(session);
  };

  for (const file of index.files) {
    if (!isRemoteTranscriptFile(file)) continue;
    const localPath = localPathForRemoteFile(cacheRoot, file.relativePath);
    if (localPath && knownPaths.has(localPath)) continue;
    const metadata =
      file.provider === "codex"
        ? [...codexMetadata.values()].find((entry) => entry.rolloutPath === file.remotePath)
        : undefined;
    add(metadata ? metadataOnlyCodexSession(metadata) : unavailableRemoteFileSession(file));
  }
  return result;
}

function parseCachedEntries(value: unknown): RemoteCacheManifest["entries"] {
  if (!isRecord(value)) return {};
  const entries: RemoteCacheManifest["entries"] = {};
  for (const [relativePath, raw] of Object.entries(value)) {
    if (!isRecord(raw) || safeRelativePath(relativePath) !== relativePath) continue;
    const remotePath = nonEmptyString(raw.remotePath);
    const size = raw.size;
    const mtimeMs = raw.mtimeMs;
    if (
      !remotePath ||
      remotePath.includes("\r") ||
      remotePath.includes("\n") ||
      remotePath.includes("\t") ||
      remotePath.includes("\0") ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof mtimeMs !== "number" ||
      !Number.isFinite(mtimeMs) ||
      mtimeMs < 0
    ) {
      continue;
    }
    entries[relativePath] = { remotePath, size, mtimeMs };
  }
  return entries;
}

async function readManifest(cacheRoot: string): Promise<RemoteCacheManifest> {
  const rootEntry = await lstat(cacheRoot).catch(() => null);
  if (!rootEntry?.isDirectory()) return emptyRemoteCacheManifest();
  const manifestPath = manifestPathForCache(cacheRoot);
  const manifestEntry = await lstat(manifestPath).catch(() => null);
  if (!manifestEntry?.isFile()) return emptyRemoteCacheManifest();
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf-8"));
    if (!isRecord(value) || value.version !== REMOTE_CACHE_VERSION || !isRecord(value.entries)) {
      return emptyRemoteCacheManifest();
    }
    return {
      version: REMOTE_CACHE_VERSION,
      home: typeof value.home === "string" ? value.home : undefined,
      entries: parseCachedEntries(value.entries),
      codexMetadata: parseCachedCodexMetadata(value.codexMetadata),
      gitRepos: parseCachedGitRepos(value.gitRepos),
    };
  } catch {
    return emptyRemoteCacheManifest();
  }
}

const REMOTE_GIT_METADATA_MARKER = "# VIBE_REPLAY_GIT_METADATA";

function buildRemoteGitMetadataScript(cwds: string[]): string {
  const safeCwds = [...new Set(cwds)]
    .filter((cwd) => cwd.length > 0 && cwd.length <= 4_096)
    .slice(0, 256);
  if (safeCwds.length === 0) return `${REMOTE_GIT_METADATA_MARKER}\n`;

  const quotedCwds = safeCwds.map(shellQuote).join(" ");
  return `${REMOTE_GIT_METADATA_MARKER}
for cwd in ${quotedCwds}; do
  url=$(git -C "$cwd" config --get remote.origin.url 2>/dev/null)
  status=$?
  if [ "$status" -eq 0 ]; then
    printf 'repo\\0%s\\0%s\\0' "$cwd" "$url"
  elif [ "$status" -eq 1 ]; then
    printf 'repo\\0%s\\0\\0' "$cwd"
  else
    printf 'repo-error\\0%s\\0\\0' "$cwd"
  fi
done
`;
}

function parseRemoteGitMetadata(output: Buffer): Map<string, string | undefined> {
  const fields = output.toString("utf-8").split("\0");
  const repos = new Map<string, string | undefined>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index] !== "repo" || !fields[index + 1]) continue;
    const url = fields[index + 2];
    repos.set(fields[index + 1], url ? normalizeGitUrl(url) : undefined);
  }
  return repos;
}

type RemoteCacheLockFailureKind = "busy" | "unsafe" | "permission" | "io";

function classifyRemoteCacheLockFailure(error: unknown): RemoteCacheLockFailureKind {
  const message = error instanceof Error ? error.message : "";
  if (message === "Remote cache is busy") return "busy";
  if (message.includes("unsafe") || message.includes("not a directory")) return "unsafe";
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return "permission";
  return "io";
}

async function queryRemoteCodexMetadata(
  target: RemoteSourceConfig,
): Promise<RemoteCodexMetadataResult> {
  try {
    return parseCodexRemoteMetadata(
      await runSsh(target, ["sh", "-s"], CODEX_REMOTE_METADATA_SCRIPT, MAX_CODEX_METADATA_BYTES),
    );
  } catch {
    return { entries: new Map(), available: false };
  }
}

async function queryRemoteGitMetadata(
  target: RemoteSourceConfig,
  sessions: SessionInfo[],
): Promise<Map<string, string | undefined>> {
  const cwds = sessions
    .map((session) => session.cwd)
    .filter((cwd): cwd is string => typeof cwd === "string" && cwd.startsWith("/"));
  if (cwds.length === 0) return new Map();
  try {
    return parseRemoteGitMetadata(
      await runSsh(target, ["sh", "-s"], buildRemoteGitMetadataScript(cwds), 1 * 1024 * 1024),
    );
  } catch {
    return new Map();
  }
}

async function extractRemoteFiles(
  target: RemoteSourceConfig,
  files: RemoteFileEntry[],
  cacheRoot: string,
): Promise<void> {
  const batches: RemoteFileEntry[][] = [];
  let batch: RemoteFileEntry[] = [];
  let commandLength = 0;
  for (const file of files) {
    const quotedLength = shellQuote(file.remotePath).length + 1;
    if (batch.length > 0 && (batch.length >= 256 || commandLength + quotedLength > 48_000)) {
      batches.push(batch);
      batch = [];
      commandLength = 0;
    }
    batch.push(file);
    commandLength += quotedLength;
  }
  if (batch.length > 0) batches.push(batch);
  for (const currentBatch of batches) {
    await extractRemoteFileBatch(target, currentBatch, cacheRoot);
  }
}

async function extractRemoteFileBatch(
  target: RemoteSourceConfig,
  files: RemoteFileEntry[],
  cacheRoot: string,
): Promise<void> {
  const fileArgs = files.map((file) => shellQuote(file.remotePath)).join(" ");
  const script = `set -e
for file in ${fileArgs}; do
  size=$(wc -c < "$file" 2>/dev/null | tr -d '[:space:]')
  case "$size" in
    ''|*[!0-9]*) exit 1 ;;
  esac
  printf '%s\\n' "$size"
  cat -- "$file"
done`;
  const child = spawnSsh(target, [script]);
  if (!child.stdout || !child.stderr || !child.stdin) {
    child.kill();
    throw new Error("SSH file transfer could not be started");
  }
  const stdout = child.stdout;
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end();

  const createdPaths: string[] = [];
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, sshTimeoutMs(target));
  const closePromise = new Promise<number | null>((resolve, reject) => {
    child.on("error", () => {
      stdout.destroy(new Error("OpenSSH client unavailable"));
      reject(new Error("OpenSSH client unavailable"));
    });
    child.on("close", resolve);
  });

  try {
    let buffer = Buffer.alloc(0);
    let fileIndex = 0;
    let remaining: number | undefined;

    for await (const rawChunk of stdout) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;

      while (buffer.length > 0) {
        if (remaining === undefined) {
          const newlineIndex = buffer.indexOf(0x0a);
          if (newlineIndex < 0) {
            if (buffer.length > 32) throw new Error("Invalid SSH file transfer header");
            break;
          }
          if (fileIndex >= files.length) throw new Error("SSH file transfer exceeded manifest");
          const sizeText = buffer.subarray(0, newlineIndex).toString("ascii");
          if (!/^(?:0|[1-9][0-9]*)$/.test(sizeText)) {
            throw new Error("Invalid SSH file transfer size");
          }
          const declaredSize = Number(sizeText);
          const file = files[fileIndex];
          if (!Number.isSafeInteger(declaredSize) || declaredSize !== file.size) {
            throw new Error("Remote file changed during transfer");
          }
          const localPath = localPathForRemoteFile(cacheRoot, file.relativePath);
          if (!localPath) throw new Error("Unsafe remote file path");
          await mkdir(dirname(localPath), { recursive: true });
          output = await open(localPath, "wx", 0o600);
          createdPaths.push(localPath);
          remaining = declaredSize;
          buffer = buffer.subarray(newlineIndex + 1);
          if (remaining === 0) {
            await output.close();
            output = undefined;
            remaining = undefined;
            fileIndex++;
          }
          continue;
        }

        if (!output) throw new Error("SSH file transfer output unavailable");
        const writeLength = Math.min(remaining, buffer.length);
        const writeBuffer = buffer.subarray(0, writeLength);
        let written = 0;
        while (written < writeBuffer.length) {
          const result = await output.write(writeBuffer, written, writeBuffer.length - written);
          if (result.bytesWritten <= 0) throw new Error("SSH file transfer write failed");
          written += result.bytesWritten;
        }
        remaining -= writeLength;
        buffer = buffer.subarray(writeLength);
        if (remaining === 0) {
          await output.close();
          output = undefined;
          remaining = undefined;
          fileIndex++;
        }
      }
    }
    const code = await closePromise;
    if (
      timedOut ||
      code !== 0 ||
      fileIndex !== files.length ||
      remaining !== undefined ||
      buffer.length !== 0
    ) {
      throw new Error(timedOut ? "SSH file transfer timed out" : "SSH file transfer failed");
    }
  } catch (error) {
    child.kill("SIGTERM");
    await output?.close().catch(() => {});
    await closePromise.catch(() => {});
    await Promise.all(createdPaths.map((path) => unlink(path).catch(() => {})));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadRemoteFile(
  target: RemoteSourceConfig,
  file: RemoteFileEntry,
  cacheRoot: string,
): Promise<void> {
  const localPath = localPathForRemoteFile(cacheRoot, file.relativePath);
  if (!localPath) throw new Error("Unsafe remote file path");
  await mkdir(dirname(localPath), { recursive: true });

  const child = spawnSsh(target, [`cat -- ${shellQuote(file.remotePath)}`]);
  if (!child.stdout || !child.stderr || !child.stdin) {
    child.kill();
    throw new Error("SSH file transfer could not be started");
  }
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  const stdinStream = child.stdin;

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(localPath, { flags: "wx", mode: 0o600 });
    let transferredBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferredBytes += chunk.length;
        if (transferredBytes > file.size) {
          callback(new Error("SSH file transfer exceeded manifest"));
        } else {
          callback(null, chunk);
        }
      },
    });
    let settled = false;
    let timedOut = false;
    let childCode: number | null = null;
    let outputFinished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, sshTimeoutMs(target));

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.destroy();
      child.kill("SIGTERM");
      void unlink(localPath).catch(() => {});
      reject(error);
    };
    const finish = (): void => {
      if (settled || childCode === null || !outputFinished) return;
      settled = true;
      clearTimeout(timer);
      if (childCode !== 0 || timedOut) {
        void unlink(localPath).catch(() => {});
        reject(new Error(timedOut ? "SSH file transfer timed out" : "SSH file transfer failed"));
      } else {
        resolve();
      }
    };

    output.on("error", () => fail(new Error("local remote-session cache could not be written")));
    limiter.on("error", () => fail(new Error("SSH file transfer exceeded manifest")));
    output.on("finish", () => {
      outputFinished = true;
      finish();
    });
    stdoutStream.pipe(limiter).pipe(output);
    stderrStream.resume();
    stdinStream.on("error", () => {});
    child.on("error", () => fail(new Error("OpenSSH client unavailable")));
    child.on("close", (code) => {
      if (settled) return;
      childCode = code;
      finish();
    });
    stdinStream.end();
  });
}

async function syncRemoteFiles(
  target: RemoteSourceConfig,
  index: RemoteIndex,
  cacheRoot: string,
  codexMetadata: RemoteCodexMetadataResult = {
    entries: new Map(),
    available: false,
  },
): Promise<void> {
  await ensureSafeCacheRoot(cacheRoot);
  const previous = await readManifest(cacheRoot);
  const currentByPath = new Map(index.files.map((file) => [file.relativePath, file]));
  const refreshedProviders = new Set(target.providers);
  const changed: RemoteFileEntry[] = [];

  for (const file of index.files) {
    const previousEntry = previous.entries[file.relativePath];
    const localInspection = await inspectCachedPath(cacheRoot, file.relativePath);
    if (localInspection.status === "unsafe") {
      throw new Error("Unsafe remote cache path");
    }
    const localStat = localInspection.status === "file" ? { size: localInspection.size } : null;
    if (
      !previousEntry ||
      previousEntry.remotePath !== file.remotePath ||
      previousEntry.size !== file.size ||
      previousEntry.mtimeMs !== file.mtimeMs ||
      !localStat ||
      localStat.size !== file.size
    ) {
      changed.push(file);
    }
  }

  const retainedEntries = preservedRemoteEntries(previous.entries, refreshedProviders);
  const removed = Object.keys(previous.entries).filter((relativePath) => {
    const provider = providerForRemoteCachePath(relativePath);
    return (
      provider !== undefined && refreshedProviders.has(provider) && !currentByPath.has(relativePath)
    );
  });
  let stagingRoot: string | undefined;
  let transactionRoot: string | undefined;
  const changedOperations: Array<{ localPath: string; backupPath?: string }> = [];
  const removedOperations: Array<{ localPath: string; backupPath: string }> = [];
  const transferredPaths = new Set<string>();
  try {
    if (changed.length > 0) {
      stagingRoot = await mkdtemp(join(cacheRoot, ".sync-"));
      await chmod(stagingRoot, 0o700).catch(() => {});
      try {
        await extractRemoteFiles(target, changed, stagingRoot);
        for (const file of changed) transferredPaths.add(file.relativePath);
      } catch (error) {
        // The framed batch protocol uses ordinary POSIX tools. Keep a bounded
        // per-file `cat` fallback for unusual remote shells or transcripts that
        // changed while the batch was being streamed.
        if (process.env.VIBE_REPLAY_DEBUG) {
          console.error(`[vibe-replay] SSH batch transfer for ${target.id} failed:`, error);
        }
        await rm(stagingRoot, { recursive: true, force: true });
        await mkdir(stagingRoot, { recursive: true });
        await chmod(stagingRoot, 0o700).catch(() => {});
        for (const file of changed) {
          let transferred = false;
          for (let attempt = 0; attempt < 2 && !transferred; attempt++) {
            try {
              const retryPath = localPathForRemoteFile(stagingRoot, file.relativePath);
              if (retryPath) await unlink(retryPath).catch(() => {});
              await downloadRemoteFile(target, file, stagingRoot);
              transferred = true;
              transferredPaths.add(file.relativePath);
            } catch (retryError) {
              if (process.env.VIBE_REPLAY_DEBUG && attempt === 1) {
                console.error(
                  `[vibe-replay] SSH transcript ${file.relativePath} was not stable:`,
                  retryError,
                );
              }
            }
          }
        }
        if (transferredPaths.size === 0 && changed.length > 0) {
          throw new Error("SSH file transfer failed", { cause: error });
        }
      }

      for (const file of changed) {
        const stagedPath = localPathForRemoteFile(stagingRoot, file.relativePath);
        const stagedInspection = await inspectCachedPath(stagingRoot, file.relativePath);
        if (stagedInspection.status !== "file" || stagedInspection.size !== file.size) {
          throw new Error("Remote file changed during transfer");
        }
        if (stagedPath) await chmod(stagedPath, 0o600).catch(() => {});
      }
    }

    if (changed.length > 0 || removed.length > 0) {
      transactionRoot = await mkdtemp(join(cacheRoot, ".transaction-"));
      await chmod(transactionRoot, 0o700).catch(() => {});
    }

    for (const file of changed) {
      if (!transferredPaths.has(file.relativePath)) continue;
      const stagedPath = stagingRoot
        ? localPathForRemoteFile(stagingRoot, file.relativePath)
        : null;
      const localPath = localPathForRemoteFile(cacheRoot, file.relativePath);
      if (!stagedPath || !localPath) throw new Error("Unsafe remote file path");
      let backupPath: string | undefined;
      if (transactionRoot) {
        const existing = await lstat(localPath).catch(() => null);
        if (existing) {
          backupPath = localPathForRemoteFile(transactionRoot, file.relativePath) || undefined;
          if (!backupPath) throw new Error("Unsafe remote file path");
          await mkdir(dirname(backupPath), { recursive: true });
          await rename(localPath, backupPath);
        }
      }
      try {
        await mkdir(dirname(localPath), { recursive: true });
        try {
          await rename(stagedPath, localPath);
        } catch {
          // Windows cannot rename over an existing file. The target is normally
          // empty after the backup move, but keep this fallback for external
          // cache changes.
          await unlink(localPath).catch(() => {});
          await rename(stagedPath, localPath);
        }
      } catch (error) {
        if (backupPath) {
          await unlink(localPath).catch(() => {});
          await rename(backupPath, localPath).catch(() => {});
        }
        throw error;
      }
      changedOperations.push({ localPath, ...(backupPath ? { backupPath } : {}) });
    }

    for (const relativePath of removed) {
      const localPath = localPathForRemoteFile(cacheRoot, relativePath);
      if (!localPath) throw new Error("Unsafe remote file path");
      const inspection = await inspectCachedPath(cacheRoot, relativePath);
      if (inspection.status === "unsafe") throw new Error("Unsafe remote cache path");
      if (inspection.status === "missing" || !transactionRoot) continue;
      const backupPath = localPathForRemoteFile(transactionRoot, relativePath);
      if (!backupPath) throw new Error("Unsafe remote file path");
      await mkdir(dirname(backupPath), { recursive: true });
      const operation = { localPath, backupPath };
      removedOperations.push(operation);
      await rename(localPath, backupPath);
    }

    const entries: RemoteCacheManifest["entries"] = { ...retainedEntries };
    for (const file of index.files) {
      entries[file.relativePath] = {
        remotePath: file.remotePath,
        size: file.size,
        mtimeMs: file.mtimeMs,
      };
    }
    const cachedCodexMetadata = codexMetadata.available ? {} : { ...previous.codexMetadata };
    for (const [sessionId, metadata] of codexMetadata.entries) {
      cachedCodexMetadata[sessionId] = metadata;
    }
    await writeRemoteManifest(cacheRoot, {
      version: REMOTE_CACHE_VERSION,
      home: index.home,
      entries,
      codexMetadata: cachedCodexMetadata,
      gitRepos: previous.gitRepos,
    });
  } catch (error) {
    for (const operation of changedOperations.toReversed()) {
      await rm(operation.localPath, { recursive: true, force: true }).catch(() => {});
      if (operation.backupPath) {
        await rename(operation.backupPath, operation.localPath).catch(() => {});
      }
    }
    for (const operation of removedOperations.toReversed()) {
      await rename(operation.backupPath, operation.localPath).catch(() => {});
    }
    throw error;
  } finally {
    if (transactionRoot) {
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  await Promise.all(
    index.files.map(async (file) => {
      const localPath = localPathForRemoteFile(cacheRoot, file.relativePath);
      if (localPath) await chmod(localPath, 0o600).catch(() => {});
    }),
  );

  for (const relativePath of removed) {
    const localPath = localPathForRemoteFile(cacheRoot, relativePath);
    if (localPath) await rm(localPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeRemoteManifest(
  cacheRoot: string,
  manifest: RemoteCacheManifest,
): Promise<void> {
  const manifestPath = manifestPathForCache(cacheRoot);
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function isSafeCacheDirectory(cacheRoot: string, relativePath: string): Promise<boolean> {
  const safePath = safeRelativePath(relativePath);
  if (!safePath) return false;
  let current = cacheRoot;
  for (const part of safePath.split("/")) {
    current = join(current, part);
    const entry = await lstat(current).catch(() => null);
    if (!entry) return true;
    if (!entry.isDirectory()) return false;
  }
  return true;
}

function redactRemoteHome(value: string, remoteHome: string): string {
  const home = remoteHome.replace(/\/+$/, "");
  if (!home || value === home) return home && value === home ? "~" : value;
  return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

async function discoverFromCache(
  target: RemoteSourceConfig,
  cacheRoot: string,
  codexMetadata: Readonly<Record<string, CodexSessionMetadata>>,
  gitRepos: Readonly<Record<string, string>>,
): Promise<SessionInfo[]> {
  const rootEntry = await lstat(cacheRoot).catch(() => null);
  if (!rootEntry?.isDirectory()) return [];
  for (const providerRoot of [".claude/projects", ".codex/sessions", ".pi/agent/sessions"]) {
    if (!(await isSafeCacheDirectory(cacheRoot, providerRoot))) return [];
  }
  const enabled = new Set(target.providers);
  const sessions: SessionInfo[] = [];
  const projectsRoot = join(cacheRoot, ".claude", "projects");
  const codexHome = join(cacheRoot, ".codex");
  const piSessionsRoot = join(cacheRoot, ".pi", "agent", "sessions");

  if (enabled.has("claude-code")) {
    try {
      sessions.push(...(await discoverClaudeCodeSessions(projectsRoot, false, true)));
    } catch {
      // A provider-specific cache parse failure must not hide other remote providers.
    }
  }
  if (enabled.has("codex")) {
    try {
      const codexSessions = await discoverCodexSessions(codexHome, false, false);
      const effectiveCodexMetadata = { ...codexMetadata };
      for (const [sessionId, threadName] of await readCodexSessionIndex(codexHome)) {
        effectiveCodexMetadata[sessionId] = {
          ...(effectiveCodexMetadata[sessionId] || { sessionId }),
          threadName,
        };
      }
      const sessionsById = new Map(codexSessions.map((session) => [session.sessionId, session]));
      for (const metadata of Object.values(effectiveCodexMetadata)) {
        if (!sessionsById.has(metadata.sessionId)) {
          sessionsById.set(metadata.sessionId, metadataOnlyCodexSession(metadata));
        }
      }
      sessions.push(
        ...[...sessionsById.values()].map((session) =>
          mergeCodexSessionMetadata(session, effectiveCodexMetadata[session.sessionId]),
        ),
      );
    } catch {
      // A provider-specific cache parse failure must not hide other remote providers.
    }
  }
  if (enabled.has("pi")) {
    try {
      sessions.push(...(await discoverPiSessions(piSessionsRoot, false, true)));
    } catch {
      // A provider-specific cache parse failure must not hide other remote providers.
    }
  }

  const location = targetLocation(target);
  return sessions.map((session) => ({
    ...session,
    location,
    ...(session.gitRepo || !session.cwd || !gitRepos[session.cwd]
      ? {}
      : { gitRepo: gitRepos[session.cwd] }),
  }));
}

function presentRemoteSessions(sessions: SessionInfo[], remoteHome: string): SessionInfo[] {
  return sessions.map((session) => ({
    ...session,
    project: redactRemoteHome(session.project, remoteHome),
    cwd: redactRemoteHome(session.cwd, remoteHome),
  }));
}

function applyRemoteGitRepos(
  sessions: SessionInfo[],
  queriedRepos: ReadonlyMap<string, string | undefined>,
  cachedRepos: Readonly<Record<string, string>>,
): SessionInfo[] {
  return sessions.map((session) => {
    if (!session.cwd) return session;
    const repo = queriedRepos.has(session.cwd)
      ? queriedRepos.get(session.cwd)
      : cachedRepos[session.cwd];
    return repo ? { ...session, gitRepo: repo } : session;
  });
}

async function updateCachedRemoteGitRepos(
  cacheRoot: string,
  queriedRepos: ReadonlyMap<string, string | undefined>,
): Promise<RemoteCacheManifest> {
  const manifest = await readManifest(cacheRoot);
  if (queriedRepos.size === 0) return manifest;

  const gitRepos = { ...manifest.gitRepos };
  for (const [cwd, repo] of queriedRepos) {
    // Empty string is a durable negative result. Without it, non-git working
    // directories trigger a fresh SSH git probe on every dashboard refresh.
    gitRepos[cwd] = repo || "";
  }
  const updated = { ...manifest, gitRepos };
  await writeRemoteManifest(cacheRoot, updated);
  return updated;
}

async function discoverRemoteTargetUnlocked(
  target: RemoteSourceConfig,
  availableProviders: ReadonlySet<string>,
  cacheRootBase?: string,
): Promise<RemoteDiscoveryResult> {
  const configuredProviders = target.providers.filter((provider) =>
    availableProviders.has(provider),
  );
  const effectiveTarget =
    configuredProviders.length === target.providers.length
      ? target
      : { ...target, providers: configuredProviders };
  if (effectiveTarget.providers.length === 0) {
    return { sessions: [], failed: false };
  }
  const cacheRoot = cacheRootForTarget(target, cacheRootBase);
  let remoteIndex: RemoteIndex | undefined;
  let currentCodexMetadata: RemoteCodexMetadataResult = {
    entries: new Map(),
    available: false,
  };

  try {
    const enabledProviders = new Set(effectiveTarget.providers);
    const discoveryOutput = await runSsh(
      target,
      ["sh", "-s"],
      enabledProviders.has("codex")
        ? `${REMOTE_DISCOVERY_SCRIPT}\n${CODEX_REMOTE_METADATA_SCRIPT.replace(
            "# VIBE_REPLAY_CODEX_METADATA",
            "# CODEX_METADATA",
          )}`
        : REMOTE_DISCOVERY_SCRIPT,
    );
    remoteIndex = parseRemoteIndex(discoveryOutput);
    const manifest = await readManifest(cacheRoot);
    const remoteHome = remoteIndex.home || manifest.home || "";
    const filteredIndex: RemoteIndex = {
      home: remoteIndex.home,
      files: remoteIndex.files.filter((file) => enabledProviders.has(file.provider)),
    };
    currentCodexMetadata = enabledProviders.has("codex")
      ? parseCodexRemoteMetadata(discoveryOutput)
      : { entries: new Map<string, CodexSessionMetadata>(), available: false };
    if (enabledProviders.has("codex") && !currentCodexMetadata.available) {
      currentCodexMetadata = await queryRemoteCodexMetadata(effectiveTarget);
    }
    await syncRemoteFiles(effectiveTarget, filteredIndex, cacheRoot, currentCodexMetadata);
    const syncedManifest = await readManifest(cacheRoot);
    const rawSessions = addMissingRemoteFileSessions(
      filteredIndex,
      await discoverFromCache(
        effectiveTarget,
        cacheRoot,
        syncedManifest.codexMetadata,
        syncedManifest.gitRepos,
      ),
      new Map(Object.entries(syncedManifest.codexMetadata)),
      cacheRoot,
    );
    const queriedRepos = await queryRemoteGitMetadata(
      effectiveTarget,
      rawSessions.filter(
        (session) => session.cwd && !Object.hasOwn(syncedManifest.gitRepos, session.cwd),
      ),
    );
    const finalManifest = await updateCachedRemoteGitRepos(cacheRoot, queriedRepos);
    if (remoteHome) remoteHomesByTarget.set(target.id, remoteHome);
    return {
      sessions: presentRemoteSessions(
        applyRemoteGitRepos(rawSessions, queriedRepos, finalManifest.gitRepos),
        remoteHome,
      ),
      failed: false,
    };
  } catch (error) {
    if (process.env.VIBE_REPLAY_DEBUG) {
      console.error(`[vibe-replay] SSH source ${target.id} failed:`, error);
    }
    const manifest = await readManifest(cacheRoot);
    const remoteHome =
      remoteIndex?.home || manifest.home || remoteHomesByTarget.get(target.id) || "";
    if (remoteHome) remoteHomesByTarget.set(target.id, remoteHome);
    const cachedSessions = await discoverFromCache(
      effectiveTarget,
      cacheRoot,
      manifest.codexMetadata,
      manifest.gitRepos,
    );
    const fallbackSessions = remoteIndex
      ? unavailableRemoteSessions(
          {
            home: remoteIndex.home,
            files: remoteIndex.files.filter((file) =>
              effectiveTarget.providers.includes(file.provider),
            ),
          },
          cachedSessions,
          currentCodexMetadata.entries,
          cacheRoot,
        )
      : cachedSessions;
    return {
      sessions: presentRemoteSessions(fallbackSessions, remoteHome),
      failed: true,
    };
  }
}

const remoteHomesByTarget = new Map<string, string>();
const remoteDiscoveryLocks = new Map<string, Promise<RemoteDiscoveryResult>>();
const remoteDiscoveryRequests = new Map<string, Promise<RemoteDiscoveryResult>>();

async function discoverRemoteTargetFromCache(
  target: RemoteSourceConfig,
  availableProviders: ReadonlySet<string>,
  cacheRootBase?: string,
): Promise<RemoteDiscoveryResult> {
  const configuredProviders = target.providers.filter((provider) =>
    availableProviders.has(provider),
  );
  const effectiveTarget =
    configuredProviders.length === target.providers.length
      ? target
      : { ...target, providers: configuredProviders };
  const cacheRoot = cacheRootForTarget(target, cacheRootBase);
  const manifest = await readManifest(cacheRoot);
  const remoteHome = manifest.home || remoteHomesByTarget.get(target.id) || "";
  if (remoteHome) remoteHomesByTarget.set(target.id, remoteHome);
  return {
    sessions: presentRemoteSessions(
      await discoverFromCache(
        effectiveTarget,
        cacheRoot,
        manifest.codexMetadata,
        manifest.gitRepos,
      ),
      remoteHome,
    ),
    failed: true,
  };
}

/**
 * Serialize discovery for one target. Source refreshes and generation can
 * overlap in the editor; without a per-target lock they could transfer files
 * concurrently and race on the manifest.
 */
function discoverRemoteTarget(
  target: RemoteSourceConfig,
  availableProviders: ReadonlySet<string>,
  cacheRootBase?: string,
): Promise<RemoteDiscoveryResult> {
  const lockKey = cacheRootForTarget(target, cacheRootBase);
  const discoveryKey = `${lockKey}\0${[...availableProviders].sort().join(",")}`;
  const inFlight = remoteDiscoveryRequests.get(discoveryKey);
  if (inFlight) return inFlight;
  const previous = remoteDiscoveryLocks.get(lockKey) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireRemoteCacheLock(lockKey);
      } catch (error) {
        const failureKind = classifyRemoteCacheLockFailure(error);
        if (process.env.VIBE_REPLAY_DEBUG) {
          console.error(`[vibe-replay] SSH cache lock for ${target.id} ${failureKind}:`, error);
        }
        if (failureKind === "unsafe") {
          return { sessions: [], failed: true };
        }
        return discoverRemoteTargetFromCache(target, availableProviders, cacheRootBase);
      }
      try {
        return await discoverRemoteTargetUnlocked(target, availableProviders, cacheRootBase);
      } finally {
        await release();
      }
    });
  const tracked = current.finally(() => {
    if (remoteDiscoveryLocks.get(lockKey) === tracked) {
      remoteDiscoveryLocks.delete(lockKey);
    }
    if (remoteDiscoveryRequests.get(discoveryKey) === tracked) {
      remoteDiscoveryRequests.delete(discoveryKey);
    }
  });
  remoteDiscoveryLocks.set(lockKey, tracked);
  remoteDiscoveryRequests.set(discoveryKey, tracked);
  return tracked;
}

/** Return the remote home prefix for replay path redaction after discovery. */
export function getRemoteHome(targetId: string | undefined): string | undefined {
  return targetId ? remoteHomesByTarget.get(targetId) : undefined;
}

/** Restore remote home prefixes from local manifests when using a stale cache. */
export async function hydrateCachedRemoteHomes(options?: RemoteDiscoveryOptions): Promise<void> {
  const targets = await loadRemoteSourceConfigs(options?.configPath);
  await Promise.all(
    targets.map(async (target) => {
      const manifest = await readManifest(cacheRootForTarget(target, options?.cacheRoot));
      if (manifest.home) remoteHomesByTarget.set(target.id, manifest.home);
    }),
  );
}

/** Discover all configured SSH targets without letting one target hide another. */
export async function discoverConfiguredRemoteSessions(
  availableProviders: Iterable<string>,
  options?: RemoteDiscoveryOptions,
): Promise<{ sessions: SessionInfo[]; failedTargets: string[] }> {
  const targets = await loadRemoteSourceConfigs(options?.configPath);
  if (targets.length === 0) return { sessions: [], failedTargets: [] };

  const providerSet = new Set(availableProviders);
  const results = await Promise.all(
    targets.map(async (target) => ({
      target,
      result: await discoverRemoteTarget(target, providerSet, options?.cacheRoot),
    })),
  );

  return {
    sessions: results.flatMap(({ result }) => result.sessions),
    failedTargets: results.filter(({ result }) => result.failed).map(({ target }) => target.id),
  };
}
