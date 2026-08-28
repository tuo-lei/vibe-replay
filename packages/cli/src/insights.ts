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
import { localDayKey } from "./utils.js";
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

  // v1 → v2: records are now keyed by provider + sessionId during merge.
  // No record rewrite is needed because both fields already existed in v1.
  if (v < 2) {
    return {
      schemaVersion: INSIGHTS_SCHEMA_VERSION,
      lastUpdated: raw.lastUpdated || new Date().toISOString(),
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    };
  }

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
    location: scan.location,
    transcriptStatus: scan.transcriptStatus,
    title: scan.title,
    project: scan.project,
    projectIdentity: scan.projectIdentity,
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
    usageSummary: scan.usageSummary,
    usageEvents: scan.usageEvents,
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
// Merge — upsert by provider + sessionId, never delete
// ---------------------------------------------------------------------------

function insightKey(provider: string, sessionId: string, targetId?: string): string {
  return `${targetId ? `${targetId}::` : ""}${provider}::${sessionId}`;
}

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
    const targetId = existing.location?.kind === "ssh" ? existing.location.id : undefined;
    byId.set(insightKey(existing.provider, existing.sessionId, targetId), existing);
  }

  for (const scan of scanResults) {
    // A failed/deferred rich scan is a coverage signal, not fresh session
    // truth. Do not replace a previously complete durable record with its
    // discovery-only placeholder.
    if (
      scan.dataQualityNotes?.some((note) =>
        /^Partial [a-z0-9_-]+(?: [a-z0-9_-]+)* scan:/i.test(note),
      )
    ) {
      continue;
    }
    const targetId = scan.location?.kind === "ssh" ? scan.location.id : undefined;
    const key = insightKey(scan.provider, scan.sessionId, targetId);
    const existing = byId.get(key);
    if (existing) {
      // Update with fresh scan data but preserve original provenance
      const updated = scanResultToInsight(scan);
      updated.capturedAt = existing.capturedAt;
      updated.updatedAt = new Date().toISOString();
      // Preserve original capture machine (session belongs to where it ran, not where it's re-scanned)
      updated.machineId = existing.machineId ?? updated.machineId;
      updated.machineName = existing.machineName ?? updated.machineName;
      byId.set(key, updated);
    } else {
      byId.set(key, scanResultToInsight(scan));
    }
  }

  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    lastUpdated: new Date().toISOString(),
    sessions: [...byId.values()],
  };
}

// ---------------------------------------------------------------------------
// Daily aggregation for cloud sync
// ---------------------------------------------------------------------------

interface DailyBreakdown {
  sessions: number;
  cost: number;
  prompts: number;
  toolCalls: number;
  edits: number;
  durationMs: number;
}

interface DailyRow {
  date: string;
  sessions: number;
  prompts: number;
  toolCalls: number;
  edits: number;
  durationMs: number;
  cost: number;
  projects: string; // JSON
  models: string; // JSON
  providers: string; // JSON
}

/**
 * Aggregate local session insights into daily rows for cloud sync.
 * Groups by date, computes JSON breakdowns for project/model/provider.
 */
export function aggregateDailyInsights(store: InsightsStore): {
  machineId: string;
  machineName: string;
  days: DailyRow[];
} {
  const byDate = new Map<
    string,
    {
      sessions: number;
      prompts: number;
      toolCalls: number;
      edits: number;
      durationMs: number;
      cost: number;
      projects: Record<string, DailyBreakdown>;
      models: Record<string, { sessions: number; cost: number }>;
      providers: Record<string, { sessions: number; cost: number }>;
    }
  >();

  for (const s of store.sessions) {
    // SSH sessions remain in the local insights store for dashboard analytics,
    // but their project/provider aggregates must not leave the machine through
    // the optional cloud sync.
    if (s.location?.kind === "ssh") continue;
    const date = localDayKey(s.startTime);
    if (!date) continue;

    let day = byDate.get(date);
    if (!day) {
      day = {
        sessions: 0,
        prompts: 0,
        toolCalls: 0,
        edits: 0,
        durationMs: 0,
        cost: 0,
        projects: {},
        models: {},
        providers: {},
      };
      byDate.set(date, day);
    }

    day.sessions++;
    day.prompts += s.promptCount;
    day.toolCalls += s.toolCallCount;
    day.edits += s.editCount;
    day.durationMs += s.durationMs || 0;
    day.cost += s.costEstimate || 0;

    // Project breakdown
    const proj = s.project;
    if (proj) {
      if (!day.projects[proj])
        day.projects[proj] = {
          sessions: 0,
          cost: 0,
          prompts: 0,
          toolCalls: 0,
          edits: 0,
          durationMs: 0,
        };
      day.projects[proj].sessions++;
      day.projects[proj].cost += s.costEstimate || 0;
      day.projects[proj].prompts += s.promptCount;
      day.projects[proj].toolCalls += s.toolCallCount;
      day.projects[proj].edits += s.editCount;
      day.projects[proj].durationMs += s.durationMs || 0;
    }

    // Model breakdown
    const model = s.model;
    if (model) {
      if (!day.models[model]) day.models[model] = { sessions: 0, cost: 0 };
      day.models[model].sessions++;
      day.models[model].cost += s.costEstimate || 0;
    }

    // Provider breakdown
    const prov = s.provider;
    if (prov) {
      if (!day.providers[prov]) day.providers[prov] = { sessions: 0, cost: 0 };
      day.providers[prov].sessions++;
      day.providers[prov].cost += s.costEstimate || 0;
    }
  }

  const days: DailyRow[] = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date,
      sessions: d.sessions,
      prompts: d.prompts,
      toolCalls: d.toolCalls,
      edits: d.edits,
      durationMs: d.durationMs,
      cost: d.cost,
      projects: JSON.stringify(d.projects),
      models: JSON.stringify(d.models),
      providers: JSON.stringify(d.providers),
    }));

  return {
    machineId: getMachineId(),
    machineName: getMachineName(),
    days,
  };
}

/** Get store stats */
export function getInsightsStats(store: InsightsStore): {
  total: number;
  providers: Record<string, number>;
  projects: number;
} {
  const providers: Record<string, number> = {};
  const projects = new Set<string>();
  for (const s of store.sessions) {
    providers[s.provider] = (providers[s.provider] || 0) + 1;
    projects.add(s.project);
  }
  return {
    total: store.sessions.length,
    providers,
    projects: projects.size,
  };
}
