import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SourceDiscoveryProgress } from "@vibe-replay/types";
import type { SessionSummary, SourceSession } from "../types";
import {
  fetchWithRetry,
  isCacheFresh,
  parseCachedList,
  remoteSourceFailureLabels,
  shouldRefreshCachedList,
  type SourcesEnrichmentStatus,
} from "../components/dashboard-utils";
export function useDashboardData() {
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [replays, setReplays] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingReplays, setLoadingReplays] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasCachedSources, setHasCachedSources] = useState(false);
  const [startupDismissed, setStartupDismissed] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState<SourceDiscoveryProgress | null>(null);
  const [failedProviders, setFailedProviders] = useState<string[]>([]);
  const [retryVersion, setRetryVersion] = useState(0);
  const [failedRemoteSources, setFailedRemoteSources] = useState<string[]>([]);
  const [enrichmentStatus, setEnrichmentStatus] = useState<SourcesEnrichmentStatus | null>(null);
  const wasEnrichingRef = useRef(false);
  const lastSourcesCachedAtRef = useRef<string | undefined>(undefined);
  const hasCursorSources = useMemo(
    () => sources.some((source) => source.provider === "cursor"),
    [sources],
  );

  const loadData = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setLoadingSources(true);
    setLoadingReplays(true);
    setError(null);
    setDiscoveryProgress(null);
    setFailedProviders([]);

    try {
      const [sourcesRes, replaysRes] = await Promise.all([
        fetch("/api/sources/cached", { cache: "no-store", signal })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/sessions/cached", { cache: "no-store", signal })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (signal.aborted) return;

      const cachedSources = parseCachedList<SourceSession>(sourcesRes);
      const cachedReplays = parseCachedList<SessionSummary>(replaysRes);
      setFailedRemoteSources(remoteSourceFailureLabels(sourcesRes));
      setFailedProviders(cachedSources?.failedProviders ?? []);
      const hasSnapshot = Boolean(
        cachedSources?.sessions.length ||
        Number.isFinite(Date.parse(cachedSources?.cachedAt ?? "")),
      );
      setHasCachedSources(hasSnapshot);

      if (cachedSources?.sessions.length) setSources(cachedSources.sessions);
      if (cachedReplays?.sessions.length) setReplays(cachedReplays.sessions);

      if (hasSnapshot) {
        setLoading(false);
      }

      const sourceFresh = !shouldRefreshCachedList(cachedSources);
      const replayFresh = isCacheFresh(cachedReplays?.cachedAt);
      const refreshPromises: Promise<void>[] = [];

      if (sourceFresh) setLoadingSources(false);
      if (replayFresh) setLoadingReplays(false);

      if (!sourceFresh) {
        // Use SSE stream for discovery with progress reporting
        refreshPromises.push(
          new Promise<void>((resolve) => {
            const es = new EventSource("/api/sources/stream");
            const finish = () => {
              es.close();
              es.onmessage = null;
              es.onerror = null;
              signal.removeEventListener("abort", finish);
              resolve();
            };
            signal.addEventListener("abort", finish, { once: true });
            es.onmessage = (evt) => {
              if (signal.aborted) return;
              try {
                const msg = JSON.parse(evt.data);
                if (msg.type === "progress") {
                  setDiscoveryProgress(msg);
                } else if (msg.type === "complete" && Array.isArray(msg.sessions)) {
                  setSources(msg.sessions);
                  setFailedRemoteSources(remoteSourceFailureLabels(msg));
                  setFailedProviders(parseCachedList<SourceSession>(msg)?.failedProviders ?? []);
                  finish();
                } else if (msg.type === "error") {
                  if (!cachedSources?.sessions.length) {
                    setError(msg.message || "Failed to load sessions");
                  }
                  finish();
                }
              } catch {
                // ignore parse errors
              }
            };
            es.onerror = () => {
              // SSE failed — fall back to regular fetch
              es.close();
              es.onmessage = null;
              es.onerror = null;
              fetchWithRetry("/api/sources", { signal })
                .then((r) => {
                  if (!r.ok) throw new Error("Failed to load sources");
                  return r.json();
                })
                .then((data: { sessions: SourceSession[]; failedProviders?: unknown }) => {
                  if (signal.aborted) return;
                  setSources(data.sessions);
                  setFailedRemoteSources(remoteSourceFailureLabels(data));
                  setFailedProviders(parseCachedList<SourceSession>(data)?.failedProviders ?? []);
                })
                .catch((err) => {
                  if (!signal.aborted && !cachedSources?.sessions.length) {
                    setError(err instanceof Error ? err.message : "Failed to load sessions");
                  }
                })
                .finally(finish);
            };
          })
            .catch((err) => {
              if (!signal.aborted)
                setError(err instanceof Error ? err.message : "Failed to load sessions");
            })
            .finally(() => {
              if (!signal.aborted) setLoadingSources(false);
            }),
        );
      }

      if (!replayFresh) {
        refreshPromises.push(
          fetchWithRetry("/api/sessions", { signal })
            .then((r) => {
              if (!r.ok) throw new Error("Failed to load replays");
              return r.json();
            })
            .then((data: SessionSummary[]) => {
              if (!signal.aborted) setReplays(data);
            })
            .catch((err) => {
              if (!signal.aborted && !cachedReplays?.sessions.length) {
                setError(err instanceof Error ? err.message : "Failed to load replays");
              }
            })
            .finally(() => {
              if (!signal.aborted) setLoadingReplays(false);
            }),
        );
      }

      if (refreshPromises.length > 0) await Promise.allSettled(refreshPromises);
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData, retryVersion]);

  useEffect(() => {
    if (!loadingSources && !hasCursorSources && !wasEnrichingRef.current) return;

    let cancelled = false;
    let timer: number | undefined;

    const maybeRefreshSourcesFromCache = async () => {
      const payload = await fetch("/api/sources/cached", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const cached = parseCachedList<SourceSession>(payload);
      if (
        !cancelled &&
        cached?.sessions.length &&
        cached.cachedAt !== lastSourcesCachedAtRef.current
      ) {
        lastSourcesCachedAtRef.current = cached.cachedAt;
        setSources(cached.sessions);
      }
    };

    const poll = async () => {
      const status = await fetch("/api/sources/enrichment-status", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<SourcesEnrichmentStatus>) : null))
        .catch(() => null);
      if (!status || cancelled) return;
      setEnrichmentStatus(status);

      if (status.running) {
        wasEnrichingRef.current = true;
        await maybeRefreshSourcesFromCache();
      } else if (wasEnrichingRef.current) {
        wasEnrichingRef.current = false;
        await maybeRefreshSourcesFromCache();
        if (timer) {
          window.clearInterval(timer);
          timer = undefined;
        }
      }
    };

    void poll();
    timer = window.setInterval(() => {
      void poll();
    }, 2500);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [hasCursorSources, loadingSources]);

  return {
    sources,
    setSources,
    replays,
    loading,
    loadingSources,
    loadingReplays,
    enrichmentStatus,
    error,
    failedRemoteSources,
    failedProviders,
    discoveryProgress,
    startupActive:
      !startupDismissed &&
      !hasCachedSources &&
      (loading ||
        Boolean(error) ||
        failedProviders.length > 0 ||
        failedRemoteSources.length > 0 ||
        sources.length === 0),
    retry: () => {
      setStartupDismissed(false);
      setRetryVersion((version) => version + 1);
    },
    dismissStartup: () => setStartupDismissed(true),
  };
}
