import {
  ensureAiDefaultSelection,
  getAiRuntime,
  getAiDefaultSelectionRevision,
  type AiDefaultSelection,
  readAiDefaultSelection,
  type AiProviderInfo,
} from "./ai-runtime.js";
import type { AiSelection } from "./feedback.js";

export interface ResolvedAiSelection {
  selection: AiSelection;
  providerName: string;
  modelId: string;
  authType: string;
  authSubscription: boolean;
  authSource?: string;
}

const PREFERRED_DEFAULT_MODEL_ID = "gpt-5.6-luna";
const PREFERRED_PROVIDER_IDS = ["custom-openai", "openai"] as const;

function parseAiSelectionBody(body: unknown): AiSelection | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as {
    providerId?: unknown;
    modelId?: unknown;
    toolName?: unknown;
  };
  const providerId = value.providerId ?? value.toolName;
  const modelId = value.modelId;
  if (providerId === undefined && modelId === undefined) return undefined;
  if (typeof providerId !== "string" || !providerId.trim()) {
    throw new Error("providerId is required");
  }
  if (modelId !== undefined && typeof modelId !== "string") {
    throw new Error("modelId must be a string");
  }
  return {
    providerId: providerId.trim(),
    ...(typeof modelId === "string" && modelId.trim() ? { modelId: modelId.trim() } : {}),
  };
}

/** Resolve a usable app default, preserving explicit choices made during seeding. */
export async function resolveDefaultAiSelection(
  providers: AiProviderInfo[],
  onCatalogRefresh?: (providers: AiProviderInfo[]) => void,
  signal?: AbortSignal,
): Promise<AiSelection | undefined> {
  signal?.throwIfAborted();
  let catalog = providers;
  let refreshCount = 0;
  let refreshObserved: AiDefaultSelection | undefined;
  const rethrowAbort = (error: unknown) => {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
  };
  /** Check the selected model against the active configured provider catalog. */
  const isUsableSelection = (selection?: AiSelection) =>
    selection !== undefined &&
    catalog.some(
      (provider) =>
        provider.configured &&
        provider.id === selection.providerId &&
        provider.models.some((model) => model.id === selection.modelId),
    );
  /** Reuse a snapshot unless a different settings revision requires revalidation. */
  const changedSince = (current?: AiDefaultSelection, observed?: AiDefaultSelection) =>
    current?.providerId !== observed?.providerId ||
    current?.modelId !== observed?.modelId ||
    getAiDefaultSelectionRevision(current) !== getAiDefaultSelectionRevision(observed);
  /** Publish every successful refresh, including an empty catalog; retain failures separately. */
  const refreshCatalog = async (observed?: AiDefaultSelection) => {
    refreshObserved = observed;
    refreshCount++;
    const refreshed = await getAiRuntime()
      .listProviders({ signal })
      .catch((error: unknown) => {
        rethrowAbort(error);
        return undefined;
      });
    signal?.throwIfAborted();
    if (refreshed) {
      catalog = refreshed;
      onCatalogRefresh?.(catalog);
    }
    const current = await readAiDefaultSelection();
    signal?.throwIfAborted();
    return current;
  };
  /** At most one extra refresh is needed for an intervening explicit settings write. */
  const revalidate = async (current?: AiDefaultSelection) => {
    if (isUsableSelection(current)) return current;
    if (refreshCount === 0 || changedSince(current, refreshObserved)) {
      while (refreshCount < 2) {
        const observed = current;
        current = await refreshCatalog(observed);
        if (isUsableSelection(current)) return current;
        if (!changedSince(current, observed)) break;
      }
    }
    return undefined;
  };
  /** Vibe Replay owns its inference policy; never choose the first arbitrary model. */
  const preferredSelection = () => {
    const provider = PREFERRED_PROVIDER_IDS.map((id) =>
      catalog.find(
        (candidate) =>
          candidate.id === id &&
          candidate.configured &&
          candidate.models.some((model) => model.id === PREFERRED_DEFAULT_MODEL_ID),
      ),
    ).find((candidate) => candidate !== undefined);
    return provider ? { providerId: provider.id, modelId: PREFERRED_DEFAULT_MODEL_ID } : undefined;
  };

  const savedDefault = await readAiDefaultSelection();
  signal?.throwIfAborted();
  if (isUsableSelection(savedDefault)) return savedDefault;
  if (
    savedDefault ||
    !catalog.some((provider) => provider.configured && provider.models.length > 0)
  ) {
    const current = await revalidate(savedDefault);
    if (current) return current;
  }
  const preferred = preferredSelection();
  if (preferred) {
    const selected = await ensureAiDefaultSelection(preferred, signal, savedDefault).catch(
      (error: unknown) => {
        rethrowAbort(error);
        return preferred;
      },
    );
    signal?.throwIfAborted();
    if (isUsableSelection(selected)) return selected;
    const current = await revalidate(selected);
    return current ?? preferredSelection();
  }
  const current = await readAiDefaultSelection();
  signal?.throwIfAborted();
  return current ? await revalidate(current) : undefined;
}

export async function resolveAiSelection(
  body: unknown,
  signal?: AbortSignal,
): Promise<ResolvedAiSelection> {
  const runtime = getAiRuntime();
  const requested = parseAiSelectionBody(body);
  let providerId = requested?.providerId;
  let defaultModelId: string | undefined;
  if (!providerId) {
    let providers = await runtime.listProviders({ signal });
    const defaultSelection = await resolveDefaultAiSelection(
      providers,
      (refreshed) => {
        providers = refreshed;
      },
      signal,
    );
    providerId = defaultSelection?.providerId;
    defaultModelId = defaultSelection?.modelId;
    if (!providerId) {
      const hasUsableProvider = providers.some(
        (provider) => provider.configured && provider.models.length > 0,
      );
      throw new Error(
        hasUsableProvider
          ? "No AI provider/model is selected. Choose a provider and model in AI Studio."
          : "No usable AI provider is configured. Set up a provider and model in AI Studio.",
      );
    }
  }

  const modelId = requested?.modelId ?? defaultModelId;
  if (!modelId) {
    throw new Error("No AI model is selected. Choose a provider and model in AI Studio.");
  }
  const resolved = await runtime.resolveModel(providerId, modelId, { signal });
  return {
    selection: {
      providerId: resolved.provider.id,
      modelId: resolved.model.id,
    },
    providerName: resolved.provider.name,
    modelId: resolved.model.id,
    authType: resolved.auth.type,
    authSubscription:
      resolved.auth.type === "oauth" && resolved.provider.auth.oauth?.isSubscription === true,
    authSource: resolved.auth.source,
  };
}
