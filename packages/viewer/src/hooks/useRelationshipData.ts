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
  const [error, setError] = useState<string | null>(cachedError);

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
      try {
        const status = await loadStatus();
        const stillRunning = status?.running === true;
        const remoteCount = status?.resultCount ?? 0;
        // Refetch results when we have nothing yet, when the scan reports more
        // sessions than we last saw, or unconditionally on the first pass.
        if (cachedSessions === null || remoteCount !== cachedResultCount) {
          await loadResults();
        }
        if (stillRunning && !cancelled) {
          pollTimer = setTimeout(tick, REFRESH_WHILE_SCANNING_MS);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to load";
        cachedError = message;
        if (!cancelled) {
          // Surface the error only when there's no cached data to fall back
          // on. Transient network/API failures shouldn't blank a Timeline that
          // already loaded successfully — leave the prior data visible.
          if (cachedSessions === null) setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
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
