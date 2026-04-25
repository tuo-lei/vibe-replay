/**
 * Hook that fetches per-session scan results for relationship visualizations.
 * Uses /api/scan/results to get SessionScanResult[] with startTime, endTime,
 * filesModified, etc. — data not available in the aggregated InsightsPanel context.
 */

import { useEffect, useState } from "react";

export interface ScanResultSession {
  sessionId: string;
  provider: string;
  project: string;
  slug: string;
  title?: string;
  firstPrompt?: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  gitBranch?: string;
  model?: string;
  promptCount: number;
  toolCallCount: number;
  editCount: number;
  filesModified: Array<{ file: string; count: number }>;
  costEstimate?: number;
  subAgentCount: number;
}

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
