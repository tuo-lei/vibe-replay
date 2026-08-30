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

export interface AiSelection {
  providerId: string;
  modelId: string;
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
  saveAiSelectionAsDefault: ((selection?: AiSelection) => void) | null;
}

const AI_SELECTION_STORAGE_KEY = "vibe-replay-ai-selection-v1";
const AI_SELECTION_CHANGE_EVENT = "vibe-replay-ai-selection-change";

interface AiSelectionPreference {
  providerId: string;
  modelId: string;
  source?: "user" | "server";
}

type AiSelectionSource = AiSelectionPreference["source"] | "draft";

function readAiSelectionPreference(): AiSelectionPreference | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(AI_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AiSelectionPreference>;
    if (typeof value.providerId !== "string" || typeof value.modelId !== "string") return null;
    return {
      providerId: value.providerId,
      modelId: value.modelId,
      ...(value.source === "user" || value.source === "server" ? { source: value.source } : {}),
    };
  } catch {
    return null;
  }
}

function writeAiSelectionPreference(value: AiSelectionPreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_SELECTION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private browsing and storage quotas should not block AI configuration.
  }
  // `storage` does not fire in the same tab. Settings/AI Studio and Ask
  // Replay each own a hook instance, so broadcast the change locally too.
  window.dispatchEvent(
    new CustomEvent<AiSelectionPreference>(AI_SELECTION_CHANGE_EVENT, {
      detail: value,
    }),
  );
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
    source?: AiSelectionSource;
  }>(() => {
    const storedPreference = readAiSelectionPreference();
    return {
      providerId: storedPreference?.providerId || null,
      modelId: storedPreference?.modelId || null,
      source: storedPreference?.source,
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
    (next: { providerId: string | null; modelId: string | null; source?: AiSelectionSource }) => {
      selectionRef.current = next;
      if (mountedRef.current) setSelection(next);
    },
    [],
  );

  // Keep independently mounted AI surfaces (AI Studio, Settings, and Ask
  // Replay) on the same provider/model without requiring a page reload.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const applyPreference = (preference: AiSelectionPreference | null) => {
      if (!preference) return;
      updateSelection(preference);
      if (mountedRef.current) setDefaultSelection(preference);
    };
    const onSelectionChange = (event: Event) => {
      const preference = (event as CustomEvent<AiSelectionPreference>).detail;
      if (
        preference &&
        typeof preference.providerId === "string" &&
        typeof preference.modelId === "string"
      ) {
        applyPreference(preference);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== AI_SELECTION_STORAGE_KEY) return;
      try {
        const value = event.newValue
          ? (JSON.parse(event.newValue) as Partial<AiSelectionPreference>)
          : null;
        applyPreference(
          value && typeof value.providerId === "string" && typeof value.modelId === "string"
            ? {
                providerId: value.providerId,
                modelId: value.modelId,
                ...(value.source === "user" || value.source === "server"
                  ? { source: value.source }
                  : {}),
              }
            : null,
        );
      } catch {
        // Ignore malformed or unavailable preferences.
      }
    };

    window.addEventListener(AI_SELECTION_CHANGE_EVENT, onSelectionChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(AI_SELECTION_CHANGE_EVENT, onSelectionChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [enabled, updateSelection]);

  // Provider/model changes are drafts. Only the explicit "Set default" action
  // writes the shared preference used by Ask Replay and the AI tools.
  const updateDraftSelection = useCallback(
    (next: { providerId: string | null; modelId: string | null }) => {
      updateSelection({ ...next, source: "draft" });
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
          defaultProvider?: { id?: unknown; modelId?: unknown } | null;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(data?.error || "AI providers could not be loaded");

        const nextProviders = parseAiProviders(data?.providers);
        if (!mountedRef.current || !isCurrentRefresh()) return;
        providersRef.current = nextProviders;
        const current = selectionRef.current;
        const currentProvider = nextProviders.find(
          (provider) => provider.id === current.providerId,
        );
        const usableProviders = nextProviders.filter(
          (provider) => provider.configured && provider.models.length > 0,
        );
        const defaultProviderId =
          typeof data?.defaultProvider?.id === "string" ? data.defaultProvider.id : null;
        const defaultModelId =
          typeof data?.defaultProvider?.modelId === "string" ? data.defaultProvider.modelId : null;
        // Preferences written before source metadata existed are treated as
        // legacy defaults. Only an explicit user selection is authoritative;
        // this lets a newly discovered server/Pi default replace an old
        // first-catalog-entry fallback without overriding deliberate choices.
        const preserveCurrentSelection =
          (current.source === "user" || current.source === "draft") && Boolean(currentProvider);
        const useServerDefault = !preserveCurrentSelection;
        const nextProviderId = !useServerDefault
          ? (currentProvider?.id ?? null)
          : defaultProviderId &&
              usableProviders.some((provider) => provider.id === defaultProviderId)
            ? defaultProviderId
            : null;
        const selectedProvider = nextProviders.find((provider) => provider.id === nextProviderId);
        const nextModelId =
          !useServerDefault &&
          current.modelId &&
          selectedProvider?.models.some((model) => model.id === current.modelId)
            ? current.modelId
            : nextProviderId === defaultProviderId &&
                defaultModelId &&
                selectedProvider?.models.some((model) => model.id === defaultModelId)
              ? defaultModelId
              : null;

        if (mountedRef.current && isCurrentRefresh()) {
          setAiProviders(nextProviders);
          updateSelection({
            providerId: nextProviderId,
            modelId: nextModelId,
            source: useServerDefault && nextProviderId && nextModelId ? "server" : current.source,
          });
          if (useServerDefault && nextProviderId && nextModelId) {
            writeAiSelectionPreference({
              providerId: nextProviderId,
              modelId: nextModelId,
              source: "server",
            });
          }
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
        updateDraftSelection({
          providerId,
          modelId: provider?.models[0]?.id || null,
        });
      }
    : null;

  const setAiModelId = enabled
    ? (modelId: string) => {
        updateDraftSelection({ ...selectionRef.current, modelId });
      }
    : null;

  const saveAiSelectionAsDefault = enabled
    ? (nextSelection?: AiSelection) => {
        const current = nextSelection || selectionRef.current;
        if (!current.providerId || !current.modelId) return;
        const next = {
          providerId: current.providerId,
          modelId: current.modelId,
          source: "user" as const,
        };
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
