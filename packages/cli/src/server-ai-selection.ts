import { getAiRuntime, readPiDefaultAiSelection, type AiProviderInfo } from "./ai-runtime.js";
import type { AiSelection } from "./feedback.js";

export interface ResolvedAiSelection {
  selection: AiSelection;
  providerName: string;
  modelId: string;
  authType: string;
  authSubscription: boolean;
  authSource?: string;
}

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

function normalizeAiBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

export async function resolveDefaultAiSelection(
  providers: AiProviderInfo[],
): Promise<AiSelection | undefined> {
  const usable = providers.filter((provider) => provider.configured && provider.models.length > 0);
  if (usable.length === 0) return undefined;

  const piDefault = await readPiDefaultAiSelection();
  if (piDefault?.providerId) {
    const matchingProvider = usable.find((provider) => provider.id === piDefault.providerId);
    if (
      matchingProvider &&
      piDefault.modelId &&
      matchingProvider.models.some((model) => model.id === piDefault.modelId)
    ) {
      return {
        providerId: matchingProvider.id,
        modelId: piDefault.modelId,
      };
    }
  }

  // Provider ids are not globally stable across runtimes. For custom
  // providers, use the configured endpoint as the identity and only accept
  // the default model when that exact provider exposes it.
  if (piDefault?.baseUrl && piDefault.modelId) {
    const normalizedBaseUrl = normalizeAiBaseUrl(piDefault.baseUrl);
    const matchingProvider = usable.find(
      (provider) =>
        provider.custom &&
        normalizeAiBaseUrl(provider.custom.baseUrl) === normalizedBaseUrl &&
        provider.models.some((model) => model.id === piDefault.modelId),
    );
    if (matchingProvider) {
      return { providerId: matchingProvider.id, modelId: piDefault.modelId };
    }
  }

  // Do not invent a provider/model when there is no explicit cross-runtime
  // identity. The UI should ask the user to choose one instead of silently
  // selecting the first catalog entry.
  return undefined;
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
