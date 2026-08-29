import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../utils/api";

export interface AiAuthMethodInfo {
  type: "api_key" | "oauth";
  label: string;
  subscription: boolean;
}

export interface AiModelInfo {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
}

export interface AiProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  authType?: "api_key" | "oauth";
  authSource?: string;
  authMethods: AiAuthMethodInfo[];
  models: AiModelInfo[];
  custom?: { baseUrl: string };
  modelError?: string;
}

export interface CustomAiProviderInput {
  name?: string;
  baseUrl: string;
  /** Blank means keep the existing stored key, if any. */
  apiKey?: string;
}

export interface AiProviderSettingsActions {
  aiProviders: AiProviderInfo[];
  aiProviderId: string | null;
  aiModelId: string | null;
  setAiProviderId: ((providerId: string) => void) | null;
  setAiModelId: ((modelId: string) => void) | null;
  refreshAiProviders: ((signal?: AbortSignal) => Promise<void>) | null;
  authenticateAiProvider:
    | ((providerId: string, method: "api_key" | "oauth", apiKey?: string) => Promise<void>)
    | null;
  cancelAiAuthentication: (() => void) | null;
  logoutAiProvider: ((providerId: string) => Promise<void>) | null;
  configureAiCustomProvider: ((config: CustomAiProviderInput) => Promise<void>) | null;
  removeAiCustomProvider: (() => Promise<void>) | null;
  aiProvidersLoading: boolean;
  aiProvidersError: string | null;
  defaultAiProviderId: string | null;
  defaultAiModelId: string | null;
  saveAiSelectionAsDefault: (() => void) | null;
}

const AI_SELECTION_STORAGE_KEY = "vibe-replay-ai-selection-v1";

interface AiSelectionPreference {
  providerId: string;
  modelId: string;
}

function readAiSelectionPreference(): AiSelectionPreference | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(AI_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AiSelectionPreference>;
    if (typeof value.providerId !== "string" || typeof value.modelId !== "string") return null;
    return { providerId: value.providerId, modelId: value.modelId };
  } catch {
    return null;
  }
}

function writeAiSelectionPreference(value: AiSelectionPreference): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AI_SELECTION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private browsing and storage quotas should not block AI configuration.
  }
}

function parseAiProviders(value: unknown): AiProviderInfo[] {
  if (!Array.isArray(value)) return [];
  return value.filter((provider): provider is AiProviderInfo => {
    if (!provider || typeof provider !== "object") return false;
    const candidate = provider as Partial<AiProviderInfo>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.name === "string" &&
      typeof candidate.configured === "boolean" &&
      Array.isArray(candidate.authMethods) &&
      Array.isArray(candidate.models)
    );
  });
}

/**
 * Shared provider/auth state for Settings, AI Studio, and future chat surfaces.
 * The component that renders this state decides whether it is inline, compact,
 * or inside a modal; network and credential behavior stays in one place.
 */
export function useAiProviderSettings(enabled: boolean): AiProviderSettingsActions {
  const [aiProviders, setAiProviders] = useState<AiProviderInfo[]>([]);
  const [selection, setSelection] = useState<{
    providerId: string | null;
    modelId: string | null;
  }>(() => {
    const storedPreference = readAiSelectionPreference();
    return {
      providerId: storedPreference?.providerId || null,
      modelId: storedPreference?.modelId || null,
    };
  });
  const [defaultSelection, setDefaultSelection] = useState<AiSelectionPreference | null>(() =>
    readAiSelectionPreference(),
  );
  const [aiProvidersLoading, setAiProvidersLoading] = useState(false);
  const [aiProvidersError, setAiProvidersError] = useState<string | null>(null);
  const providersRef = useRef<AiProviderInfo[]>([]);
  const selectionRef = useRef(selection);
  const authAbortRef = useRef<AbortController | null>(null);
  const refreshSequenceRef = useRef(0);
  const mountedRef = useRef(true);

  const updateSelection = useCallback(
    (next: { providerId: string | null; modelId: string | null }) => {
      selectionRef.current = next;
      if (mountedRef.current) setSelection(next);
    },
    [],
  );

  // Provider/model selection is a local preference, not replay or credential
  // data. Remember it as soon as the user changes it so reopening AI Studio
  // does not silently fall back to the first discovered model. The explicit
  // "Set default" action remains available as a visible confirmation and for
  // callers that want to save the current choice deliberately.
  const rememberSelection = useCallback(
    (next: { providerId: string | null; modelId: string | null }) => {
      updateSelection(next);
      if (!next.providerId || !next.modelId) return;
      const preference = { providerId: next.providerId, modelId: next.modelId };
      writeAiSelectionPreference(preference);
      if (mountedRef.current) setDefaultSelection(preference);
    },
    [updateSelection],
  );

  const refreshAiProviders = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled) return;
      const refreshSequence = ++refreshSequenceRef.current;
      const isCurrentRefresh = () => refreshSequenceRef.current === refreshSequence;
      if (mountedRef.current) {
        setAiProvidersLoading(true);
        setAiProvidersError(null);
      }
      try {
        const response = await fetch(apiUrl("/api/ai/providers"), {
          cache: "no-store",
          signal,
        });
        const data = (await response.json().catch(() => null)) as {
          providers?: unknown;
          defaultProvider?: { id?: unknown } | null;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(data?.error || "AI providers could not be loaded");

        const nextProviders = parseAiProviders(data?.providers);
        if (!mountedRef.current || !isCurrentRefresh()) return;
        providersRef.current = nextProviders;
        const current = selectionRef.current;
        const nextProviderId =
          current.providerId && nextProviders.some((provider) => provider.id === current.providerId)
            ? current.providerId
            : typeof data?.defaultProvider?.id === "string" &&
                nextProviders.some((provider) => provider.id === data.defaultProvider?.id)
              ? data.defaultProvider.id
              : nextProviders[0]?.id || null;
        const selectedProvider = nextProviders.find((provider) => provider.id === nextProviderId);
        const nextModelId =
          current.modelId && selectedProvider?.models.some((model) => model.id === current.modelId)
            ? current.modelId
            : selectedProvider?.models[0]?.id || null;

        if (mountedRef.current && isCurrentRefresh()) {
          setAiProviders(nextProviders);
          updateSelection({ providerId: nextProviderId, modelId: nextModelId });
        }
      } catch (error) {
        if (
          mountedRef.current &&
          isCurrentRefresh() &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setAiProvidersError(
            error instanceof Error ? error.message : "AI providers could not be loaded",
          );
        }
        throw error;
      } finally {
        if (mountedRef.current && isCurrentRefresh()) setAiProvidersLoading(false);
      }
    },
    [enabled, updateSelection],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) refreshAiProviders().catch(() => {});
    return () => {
      refreshSequenceRef.current += 1;
      mountedRef.current = false;
      authAbortRef.current?.abort();
    };
  }, [enabled, refreshAiProviders]);

  const setAiProviderId = enabled
    ? (providerId: string) => {
        const provider = providersRef.current.find((candidate) => candidate.id === providerId);
        rememberSelection({
          providerId,
          modelId: provider?.models[0]?.id || null,
        });
      }
    : null;

  const setAiModelId = enabled
    ? (modelId: string) => {
        rememberSelection({ ...selectionRef.current, modelId });
      }
    : null;

  const saveAiSelectionAsDefault = enabled
    ? () => {
        const current = selectionRef.current;
        if (!current.providerId || !current.modelId) return;
        const next = { providerId: current.providerId, modelId: current.modelId };
        writeAiSelectionPreference(next);
        updateSelection(next);
        if (mountedRef.current) setDefaultSelection(next);
      }
    : null;

  const authenticateAiProvider = enabled
    ? async (providerId: string, method: "api_key" | "oauth", apiKey?: string) => {
        const controller = new AbortController();
        authAbortRef.current = controller;
        try {
          const response = await fetch(apiUrl("/api/ai/auth"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerId, method, ...(apiKey ? { apiKey } : {}) }),
            signal: controller.signal,
          });
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          if (!response.ok) throw new Error(data?.error || "AI authentication failed");
          controller.signal.throwIfAborted();
          await refreshAiProviders(controller.signal);
        } finally {
          if (authAbortRef.current === controller) authAbortRef.current = null;
        }
      }
    : null;

  const cancelAiAuthentication = enabled
    ? () => {
        authAbortRef.current?.abort();
      }
    : null;

  const logoutAiProvider = enabled
    ? async (providerId: string) => {
        const query = `?providerId=${encodeURIComponent(providerId)}`;
        const response = await fetch(apiUrl(`/api/ai/auth${query}`), { method: "DELETE" });
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(data?.error || "AI logout failed");
        await refreshAiProviders();
      }
    : null;

  const configureAiCustomProvider = enabled
    ? async (config: CustomAiProviderInput) => {
        const controller = new AbortController();
        authAbortRef.current = controller;
        try {
          const response = await fetch(apiUrl("/api/ai/custom"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
            signal: controller.signal,
          });
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          if (!response.ok) throw new Error(data?.error || "Custom AI provider setup failed");
          controller.signal.throwIfAborted();
          await refreshAiProviders(controller.signal);
        } finally {
          if (authAbortRef.current === controller) authAbortRef.current = null;
        }
      }
    : null;

  const removeAiCustomProvider = enabled
    ? async () => {
        const response = await fetch(apiUrl("/api/ai/custom"), { method: "DELETE" });
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(data?.error || "Custom AI provider removal failed");
        await refreshAiProviders();
      }
    : null;

  return {
    aiProviders,
    aiProviderId: selection.providerId,
    aiModelId: selection.modelId,
    setAiProviderId,
    setAiModelId,
    refreshAiProviders: enabled ? refreshAiProviders : null,
    authenticateAiProvider,
    cancelAiAuthentication,
    logoutAiProvider,
    configureAiCustomProvider,
    removeAiCustomProvider,
    aiProvidersLoading,
    aiProvidersError,
    defaultAiProviderId: defaultSelection?.providerId || null,
    defaultAiModelId: defaultSelection?.modelId || null,
    saveAiSelectionAsDefault,
  };
}
