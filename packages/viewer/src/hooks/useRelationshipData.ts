/**
 * Hook that fetches per-session scan results for relationship visualizations.
 * Uses /api/scan/results which returns SessionScanResult shape (defined in
 * packages/cli/src/scanner.ts) — the wire-format subset is canonicalized as
 * SessionScanWireData in @vibe-replay/types.
 */

import type { SessionScanWireData } from "@vibe-replay/types";
import { useEffect, useState } from "react";

export type ScanResultSession = SessionScanWireData;

export interface RelationshipData {
  sessions: ScanResultSession[];
  loading: boolean;
  error: string | null;
}

interface ScanStatus {
  running?: boolean;
  resultCount?: number;
}

let cachedSessions: ScanResultSession[] | null = null;
let cachedError: string | null = null;
let cachedResultCount = 0;

const REFRESH_WHILE_SCANNING_MS = 4000;

export function useRelationshipData(): RelationshipData {
  const [sessions, setSessions] = useState<ScanResultSession[]>(cachedSessions ?? []);
  const [loading, setLoading] = useState(cachedSessions === null && cachedError === null);
  // Only restore an error state if we have no cached data to fall back on —
  // otherwise a stale cachedError from a previous transient failure would
  // render the error screen over still-usable sessions.
  const [error, setError] = useState<string | null>(cachedSessions === null ? cachedError : null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function loadResults() {
      const resp = await fetch("/api/scan/results");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { results: ScanResultSession[] };
      cachedSessions = data.results ?? [];
      cachedResultCount = cachedSessions.length;
      cachedError = null;
      if (!cancelled) {
        setSessions(cachedSessions);
        setError(null);
      }
    }

    async function loadStatus(): Promise<ScanStatus | null> {
      try {
        const resp = await fetch("/api/scan/status");
        if (!resp.ok) return null;
        return (await resp.json()) as ScanStatus;
      } catch {
        return null;
      }
    }

    async function tick() {
      let stillRunning = false;
      try {
        const status = await loadStatus();
        stillRunning = status?.running === true;
        const remoteCount = status?.resultCount ?? 0;
        // Refetch results when we have nothing yet or the count diverges.
        if (cachedSessions === null || remoteCount !== cachedResultCount) {
          await loadResults();
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to load";
        cachedError = message;
        if (!cancelled && cachedSessions === null) {
          // Only blank the view if there's no cached data. A transient
          // refresh failure should leave the prior data on screen.
          setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
        // Keep polling while the scan is running, even if this tick errored —
        // a single transient 5xx shouldn't stop the live updates permanently.
        if (!cancelled && stillRunning) {
          pollTimer = setTimeout(tick, REFRESH_WHILE_SCANNING_MS);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  return { sessions, loading, error };
}
