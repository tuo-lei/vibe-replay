import {
  ensureAiDefaultSelection,
  getAiRuntime,
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
): Promise<AiSelection | undefined> {
  const usable = providers.filter((provider) => provider.configured && provider.models.length > 0);
  /** Check the selected model against configured providers in a catalog snapshot. */
  const isUsableSelection = (selection: AiSelection, candidates = usable) =>
    candidates.some(
      (provider) =>
        provider.configured &&
        provider.id === selection.providerId &&
        provider.models.some((model) => model.id === selection.modelId),
    );
  /** Re-read concurrent choices against a fresh catalog before publishing a default. */
  const resolveAfterRefresh = async (selection?: AiSelection) => {
    const refreshed = await getAiRuntime()
      .listProviders()
      .catch(() => []);
    const current = await readAiDefaultSelection();
    const resolved =
      current && isUsableSelection(current, refreshed)
        ? current
        : selection && isUsableSelection(selection, refreshed)
          ? selection
          : undefined;
    if (!resolved) return undefined;
    onCatalogRefresh?.(refreshed);
    return resolved;
  };

  const savedDefault = await readAiDefaultSelection();
  if (savedDefault && isUsableSelection(savedDefault)) return savedDefault;
  if (savedDefault || usable.length === 0) {
    const refreshed = await resolveAfterRefresh(savedDefault);
    if (refreshed) return refreshed;
  }
  if (usable.length === 0) return undefined;

  // Vibe Replay owns its default. Prefer Luna when the configured provider
  // exposes it, with the local/custom endpoint ahead of a direct API key.
  const preferredProvider = PREFERRED_PROVIDER_IDS.map((id) =>
    usable.find(
      (provider) =>
        provider.id === id &&
        provider.models.some((model) => model.id === PREFERRED_DEFAULT_MODEL_ID),
    ),
  ).find((provider): provider is AiProviderInfo => provider !== undefined);
  if (preferredProvider) {
    const preferred = {
      providerId: preferredProvider.id,
      modelId: PREFERRED_DEFAULT_MODEL_ID,
    };
    // Repair only the invalid choice we observed, preserving concurrent writes.
    const selected = await ensureAiDefaultSelection(preferred, undefined, savedDefault).catch(
      () => preferred,
    );
    if (isUsableSelection(selected)) return selected;
    return (await resolveAfterRefresh(selected)) ?? preferred;
  }

  // Do not invent a provider/model or silently select the first catalog entry.
  // The UI should ask the user to choose one when Luna is unavailable.
  return await resolveAfterRefresh();
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
    const providers = await runtime.listProviders({ signal });
    const defaultSelection = await resolveDefaultAiSelection(providers);
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
