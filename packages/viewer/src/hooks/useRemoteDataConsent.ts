import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../utils/api";
import { safeStorageGet, safeStorageSet } from "../utils/safe-storage";

export const REMOTE_DATA_CONSENT_STORAGE_KEY = "vibe-replay-ssh-data-consent-v1";
export const REMOTE_DATA_CONSENT_CHANGE_EVENT = "vibe-replay-ssh-data-consent-change";
export const REMOTE_SOURCES_CHANGE_EVENT = "vibe-replay-remote-sources-change";

export interface RemoteDataConsentActions {
  allowRemoteData: boolean;
  setAllowRemoteData: (allowed: boolean) => void;
  hasConfiguredRemoteSource: boolean;
  remoteSourcesLoading: boolean;
}

function readAllowRemoteData(): boolean {
  return safeStorageGet(localStorage, REMOTE_DATA_CONSENT_STORAGE_KEY) === "1";
}

export function notifyRemoteSourcesChanged(hasConfiguredRemoteSource: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(REMOTE_SOURCES_CHANGE_EVENT, {
      detail: hasConfiguredRemoteSource,
    }),
  );
}

function parseHasConfiguredRemoteSource(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const remoteSources = (value as { remoteSources?: unknown }).remoteSources;
  return Array.isArray(remoteSources) && remoteSources.length > 0;
}

/**
 * Shared browser-local SSH data consent for Ask Replay and Settings.
 * Remote-source discovery is fetched here for surfaces that do not already
 * own the Settings source list; Settings can pass its loaded source count.
 */
export function useRemoteDataConsent(
  enabled: boolean,
  configuredRemoteSourceCount?: number,
): RemoteDataConsentActions {
  const [allowRemoteData, setAllowRemoteDataState] = useState(readAllowRemoteData);
  const [hasConfiguredRemoteSource, setHasConfiguredRemoteSource] = useState(
    configuredRemoteSourceCount !== undefined ? configuredRemoteSourceCount > 0 : false,
  );
  const [remoteSourcesLoading, setRemoteSourcesLoading] = useState(
    enabled && configuredRemoteSourceCount === undefined,
  );

  const setAllowRemoteData = useCallback((allowed: boolean) => {
    safeStorageSet(localStorage, REMOTE_DATA_CONSENT_STORAGE_KEY, allowed ? "1" : "0");
    setAllowRemoteDataState(allowed);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent<boolean>(REMOTE_DATA_CONSENT_CHANGE_EVENT, { detail: allowed }),
      );
    }
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const onConsentChange = (event: Event) => {
      const allowed = (event as CustomEvent<boolean>).detail;
      if (typeof allowed === "boolean") setAllowRemoteDataState(allowed);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== REMOTE_DATA_CONSENT_STORAGE_KEY) return;
      setAllowRemoteDataState(event.newValue === "1");
    };
    const onRemoteSourcesChange = (event: Event) => {
      if (configuredRemoteSourceCount !== undefined) return;
      const hasSource = (event as CustomEvent<boolean>).detail;
      if (typeof hasSource === "boolean") {
        setHasConfiguredRemoteSource(hasSource);
        setRemoteSourcesLoading(false);
      }
    };

    window.addEventListener(REMOTE_DATA_CONSENT_CHANGE_EVENT, onConsentChange);
    window.addEventListener("storage", onStorage);
    window.addEventListener(REMOTE_SOURCES_CHANGE_EVENT, onRemoteSourcesChange);
    return () => {
      window.removeEventListener(REMOTE_DATA_CONSENT_CHANGE_EVENT, onConsentChange);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(REMOTE_SOURCES_CHANGE_EVENT, onRemoteSourcesChange);
    };
  }, [configuredRemoteSourceCount, enabled]);

  useEffect(() => {
    if (!enabled) {
      setHasConfiguredRemoteSource(false);
      setRemoteSourcesLoading(false);
      return;
    }
    if (configuredRemoteSourceCount !== undefined) {
      setHasConfiguredRemoteSource(configuredRemoteSourceCount > 0);
      setRemoteSourcesLoading(false);
      return;
    }

    let cancelled = false;
    setRemoteSourcesLoading(true);
    void fetch(apiUrl("/api/settings"), { cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((data) => {
        if (cancelled) return;
        const hasSource = parseHasConfiguredRemoteSource(data);
        setHasConfiguredRemoteSource(hasSource);
        setRemoteSourcesLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Fail closed: an unavailable Settings endpoint must not surface a
        // prompt that suggests SSH data can be sent.
        setHasConfiguredRemoteSource(false);
        setRemoteSourcesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [configuredRemoteSourceCount, enabled]);

  return {
    allowRemoteData,
    setAllowRemoteData,
    hasConfiguredRemoteSource,
    remoteSourcesLoading,
  };
}
