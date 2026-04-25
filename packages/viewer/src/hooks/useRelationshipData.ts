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

let cachedSessions: ScanResultSession[] | null = null;
let cachedError: string | null = null;

export function useRelationshipData(): RelationshipData {
  const [sessions, setSessions] = useState<ScanResultSession[]>(cachedSessions ?? []);
  const [loading, setLoading] = useState(cachedSessions === null && cachedError === null);
  const [error, setError] = useState<string | null>(cachedError);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const resp = await fetch("/api/scan/results");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { results: ScanResultSession[] };
        cachedSessions = data.results ?? [];
        cachedError = null;
        if (!cancelled) {
          setSessions(cachedSessions);
          setError(null);
        }
      } catch (e) {
        cachedError = e instanceof Error ? e.message : "Failed to load";
        if (!cancelled) {
          setError(cachedError);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { sessions, loading, error };
}
