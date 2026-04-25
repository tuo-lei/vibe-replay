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

export function useRelationshipData(): RelationshipData {
  const [sessions, setSessions] = useState<ScanResultSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const resp = await fetch("/api/scan/results");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { results: ScanResultSession[] };
        if (!cancelled) {
          setSessions(data.results ?? []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
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
