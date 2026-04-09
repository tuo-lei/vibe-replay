/**
 * Local Insights Store — durable session insights that survive source file deletion.
 *
 * Unlike the ephemeral scan cache (which invalidates on CLI version change), the
 * insights store persists indefinitely at ~/.vibe-replay/insights/store.json.
 * This ensures insights remain available even after Claude Code's 30-day JSONL
 * cleanup or Cursor transcript deletion.
 *
 * Key design:
 * - Schema versioned independently from CLI version (forward-migrated, never invalidated)
 * - Append/update only — sessions are never deleted from the store
 * - Sync state tracked per-session for cloud sync
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InsightsStore, SessionInsight } from "@vibe-replay/types";
import { INSIGHTS_SCHEMA_VERSION } from "@vibe-replay/types";
import { getMachineId, getMachineName } from "./machine-id.js";
import type { SessionScanResult } from "./scanner.js";
import { CLI_VERSION } from "./version.js";

const INSIGHTS_DIR = join(homedir(), ".vibe-replay", "insights");
const STORE_PATH = join(INSIGHTS_DIR, "store.json");

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export async function readInsightsStore(): Promise<InsightsStore> {
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<InsightsStore>;
    return migrateInsightsStore(parsed);
  } catch {
    return emptyStore();
  }
}

export async function writeInsightsStore(store: InsightsStore): Promise<void> {
  try {
    await mkdir(dirname(STORE_PATH), { recursive: true });
    const output = { ...store, lastUpdated: new Date().toISOString() };
    // Write to temp then rename (atomic on POSIX same-filesystem)
    const tmpPath = `${STORE_PATH}.tmp`;
    await writeFile(tmpPath, JSON.stringify(output), "utf-8");
    await rename(tmpPath, STORE_PATH);
  } catch {
    // Best-effort — never break core flows
  }
}

function emptyStore(): InsightsStore {
  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    lastUpdated: new Date().toISOString(),
    sessions: [],
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function migrateInsightsStore(raw: Partial<InsightsStore>): InsightsStore {
  if (!raw || typeof raw !== "object") return emptyStore();
  const v = raw.schemaVersion ?? 0;

  // v0 → v1: initial schema
  if (v < 1) {
    return {
      schemaVersion: INSIGHTS_SCHEMA_VERSION,
      lastUpdated: raw.lastUpdated || new Date().toISOString(),
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    };
  }

  // Future migrations go here:
  // if (v < 2) { ... }

  // Ensure required fields exist even for current/future schema versions
  return {
    schemaVersion: raw.schemaVersion ?? INSIGHTS_SCHEMA_VERSION,
    lastUpdated: raw.lastUpdated || new Date().toISOString(),
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
  };
}

// ---------------------------------------------------------------------------
// Conversion: SessionScanResult → SessionInsight
// ---------------------------------------------------------------------------

export function scanResultToInsight(scan: SessionScanResult): SessionInsight {
  return {
    sessionId: scan.sessionId,
    slug: scan.slug,
    provider: scan.provider,
    title: scan.title,
    project: scan.project,
    model: scan.model,
    gitBranch: scan.gitBranch,
    gitBranches: scan.gitBranches,
    startTime: scan.startTime,
    endTime: scan.endTime,
    durationMs: scan.durationMs,
    promptCount: scan.promptCount,
    toolCallCount: scan.toolCallCount,
    editCount: scan.editCount,
    filesModified: scan.filesModified?.length ? scan.filesModified : undefined,
    tokenUsage: scan.tokenUsage,
    costEstimate: scan.costEstimate,
    hasPR: !!(scan.prLinks && scan.prLinks.length > 0),
    prLinks: scan.prLinks,
    skillsUsed: scan.skillsUsed,
    mcpServersUsed: scan.mcpServersUsed,
    subAgentCount: scan.subAgentCount,
    apiErrorCount: scan.apiErrorCount,
    compactionCount: scan.compactionCount,
    entrypoint: scan.entrypoint,
    permissionMode: scan.permissionMode,
    firstPrompt: scan.firstPrompt,
    capturedAt: new Date().toISOString(),
    capturedByVersion: CLI_VERSION,
    machineId: getMachineId(),
    machineName: getMachineName(),
    dataSource: scan.dataSource,
  };
}

// ---------------------------------------------------------------------------
// Merge — upsert by sessionId, never delete
// ---------------------------------------------------------------------------

/**
 * Merge new scan results into the insights store.
 * - New sessions are inserted
 * - Existing sessions are updated (if source files still exist = re-scanned)
 * - Sessions whose source files are gone are kept as-is (precious!)
 */
export function mergeInsights(
  store: InsightsStore,
  scanResults: SessionScanResult[],
): InsightsStore {
  const byId = new Map<string, SessionInsight>();
  for (const existing of store.sessions) {
    byId.set(existing.sessionId, existing);
  }

  for (const scan of scanResults) {
    const existing = byId.get(scan.sessionId);
    if (existing) {
      // Update with fresh scan data but preserve original provenance + sync state
      const updated = scanResultToInsight(scan);
      updated.capturedAt = existing.capturedAt;
      updated.updatedAt = new Date().toISOString();
      updated.syncedAt = existing.syncedAt;
      updated.cloudId = existing.cloudId;
      // Preserve original capture machine (session belongs to where it ran, not where it's re-scanned)
      updated.machineId = existing.machineId ?? updated.machineId;
      updated.machineName = existing.machineName ?? updated.machineName;
      byId.set(scan.sessionId, updated);
    } else {
      byId.set(scan.sessionId, scanResultToInsight(scan));
    }
  }

  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    lastUpdated: new Date().toISOString(),
    sessions: [...byId.values()],
  };
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

/** Get insights that need syncing (never synced or updated since last sync) */
export function getUnsyncedInsights(store: InsightsStore): SessionInsight[] {
  return store.sessions.filter((s) => {
    if (!s.syncedAt) return true;
    if (s.updatedAt && s.updatedAt > s.syncedAt) return true;
    return false;
  });
}

/** Mark sessions as synced after successful cloud upload */
export function markSynced(
  store: InsightsStore,
  syncedIds: Map<string, string>, // sessionId → cloudId
): InsightsStore {
  const now = new Date().toISOString();
  const sessions = store.sessions.map((s) => {
    const cloudId = syncedIds.get(s.sessionId);
    if (cloudId !== undefined) {
      return { ...s, syncedAt: now, cloudId };
    }
    return s;
  });
  return { ...store, sessions, lastUpdated: now };
}

/** Get store file path (for display/debugging) */
export function getInsightsStorePath(): string {
  return STORE_PATH;
}

/** Get store stats */
export function getInsightsStats(store: InsightsStore): {
  total: number;
  synced: number;
  unsynced: number;
  providers: Record<string, number>;
  projects: number;
} {
  let synced = 0;
  const providers: Record<string, number> = {};
  const projects = new Set<string>();
  for (const s of store.sessions) {
    if (s.syncedAt) synced++;
    providers[s.provider] = (providers[s.provider] || 0) + 1;
    projects.add(s.project);
  }
  return {
    total: store.sessions.length,
    synced,
    unsynced: store.sessions.length - synced,
    providers,
    projects: projects.size,
  };
}
