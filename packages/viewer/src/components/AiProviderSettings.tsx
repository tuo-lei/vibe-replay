import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type {
  AiAuthMethodInfo,
  AiModelInfo,
  AiProviderInfo,
  AiProviderSettingsActions,
} from "../hooks/useAiProviderSettings";

export interface AiProviderSettingsProps {
  actions: AiProviderSettingsActions;
  /** Compact omits the outer section shell; inline is for the global Settings page. */
  variant?: "compact" | "inline";
  /** Disable selection and edits while another AI Studio operation is running. */
  busy?: boolean;
  onProviderChange?: (providerId: string) => void;
  onModelChange?: (modelId: string) => void;
}

export interface AiProviderSettingsModalProps extends AiProviderSettingsProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  onOpenSettings?: () => void;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-terminal-border-subtle bg-terminal-surface px-2.5 py-1.5 text-xs font-mono text-terminal-text outline-none placeholder:text-terminal-dimmer focus:border-terminal-purple/50 disabled:opacity-50";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function providerStatus(provider: AiProviderInfo, method?: AiAuthMethodInfo["type"]): string {
  if (!provider.configured || (method && provider.authType !== method)) return "not configured";
  if (provider.authType === "oauth") {
    return provider.authMethods.find((candidate) => candidate.type === "oauth")?.subscription
      ? "subscription / OAuth"
      : "OAuth";
  }
  return provider.authSource || "API key";
}

function authMethodKind(method: AiAuthMethodInfo): string {
  return method.type === "oauth" ? "Account login" : "API key";
}

function ProviderAuthCard({
  provider,
  method,
  selected,
  disabled,
  onSelect,
}: {
  provider: AiProviderInfo;
  method: AiAuthMethodInfo;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const configured = provider.configured && provider.authType === method.type;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
        selected
          ? "border-terminal-purple/50 bg-terminal-purple-subtle"
          : "border-terminal-border-subtle bg-terminal-bg hover:border-terminal-purple/30"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-mono font-semibold text-terminal-text">
          {provider.name}
        </span>
        <span
          className={`shrink-0 text-[9px] font-mono ${
            configured ? "text-terminal-green" : "text-terminal-orange"
          }`}
        >
          {configured ? "ready" : "setup"}
        </span>
      </div>
      <div className="mt-1 text-[10px] font-mono text-terminal-dimmer">
        {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
      </div>
      <div className="mt-2 text-[10px] font-mono text-terminal-purple">
        {authMethodKind(method)}
        {method.subscription ? " · subscription" : ""}
      </div>
    </button>
  );
}

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: AiModelInfo[];
  value: string;
  onChange: (modelId: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const selected = models.find((model) => model.id === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(normalizedQuery))
    : models;

  const positionMenu = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;

    const rect = root.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 6;
    const width = Math.min(
      512,
      Math.max(rect.width, 240),
      Math.max(160, window.innerWidth - viewportPadding * 2),
    );
    const left = Math.min(
      Math.max(rect.left, viewportPadding),
      Math.max(viewportPadding, window.innerWidth - viewportPadding - width),
    );
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap);
    const spaceAbove = Math.max(0, rect.top - gap);
    const openAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const availableSpace = openAbove ? spaceAbove : spaceBelow;

    setMenuPosition({
      left,
      width,
      maxHeight: Math.max(160, Math.min(360, availableSpace || 360)),
      ...(openAbove
        ? { bottom: Math.max(gap, window.innerHeight - rect.top + gap) }
        : { top: rect.bottom + gap }),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    positionMenu();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current &&
        !rootRef.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, positionMenu]);

  useEffect(() => {
    if (open && menuPosition) filterInputRef.current?.focus();
  }, [menuPosition, open]);

  const menu =
    open && menuPosition
      ? createPortal(
          <div
            ref={menuRef}
            aria-label="AI model options"
            className="fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-terminal-border bg-terminal-surface shadow-layer-xl"
            style={
              {
                left: menuPosition.left,
                width: menuPosition.width,
                maxHeight: menuPosition.maxHeight,
                ...(menuPosition.top !== undefined
                  ? { top: menuPosition.top }
                  : { bottom: menuPosition.bottom }),
              } as CSSProperties
            }
          >
            <div className="shrink-0 border-b border-terminal-border-subtle p-2">
              <input
                ref={filterInputRef}
                aria-label="Filter AI models"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Filter ${models.length} models…`}
                className="w-full rounded-lg border border-terminal-border-subtle bg-terminal-bg px-2.5 py-2 text-xs font-mono text-terminal-text outline-none placeholder:text-terminal-dimmer focus:border-terminal-purple/50"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {filtered.length > 0 ? (
                filtered.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    aria-pressed={model.id === value}
                    onClick={() => {
                      onChange(model.id);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`flex w-full items-start justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-terminal-purple-subtle ${
                      model.id === value
                        ? "bg-terminal-purple-subtle text-terminal-text"
                        : "text-terminal-dim"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-mono">
                        {model.name || model.id}
                      </span>
                      {model.name && model.name !== model.id && (
                        <span className="mt-0.5 block truncate text-[10px] font-mono text-terminal-dimmer">
                          {model.id}
                        </span>
                      )}
                    </span>
                    {model.id === value && <span className="shrink-0 text-terminal-purple">✓</span>}
                  </button>
                ))
              ) : (
                <div className="px-2.5 py-4 text-center text-[10px] font-mono text-terminal-dimmer">
                  No matching models.
                </div>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-label="AI model"
        aria-haspopup={true}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
          setQuery("");
        }}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-terminal-border bg-terminal-surface px-2.5 py-2 text-left text-xs font-mono text-terminal-text outline-none transition-colors hover:border-terminal-purple/40 disabled:opacity-50"
      >
        <span className="min-w-0 truncate">{selected?.name || value || "Select a model"}</span>
        <span className="shrink-0 text-terminal-dimmer">⌄</span>
      </button>
      {menu}
    </div>
  );
}

export function AiProviderSettings({
  actions,
  variant = "compact",
  busy = false,
  onProviderChange,
  onModelChange,
}: AiProviderSettingsProps) {
  const {
    aiProviders: providers,
    aiProviderId: providerId,
    aiModelId: modelId,
    setAiProviderId,
    setAiModelId,
    refreshAiProviders,
    authenticateAiProvider,
    cancelAiAuthentication,
    logoutAiProvider,
    configureAiCustomProvider,
    removeAiCustomProvider,
    aiProvidersLoading,
    aiProvidersError,
    defaultAiProviderId,
    defaultAiModelId,
    saveAiSelectionAsDefault,
  } = actions;
  const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">("api_key");
  const authMethodOverrideRef = useRef<{
    providerId: string;
    method: AiAuthMethodInfo["type"];
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [authRunning, setAuthRunning] = useState(false);
  const [authStatus, setAuthStatus] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [customName, setCustomName] = useState("Custom gateway");
  const [customBaseUrl, setCustomBaseUrl] = useState("http://127.0.0.1:58788/v1");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customRunning, setCustomRunning] = useState(false);
  const [customStatus, setCustomStatus] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const selectedProvider = providers.find((provider) => provider.id === providerId) || null;
  const selectedAuthMethod = selectedProvider?.authMethods.find(
    (method) => method.type === authMethod,
  );
  const selectedProviderAuthStatus = selectedProvider
    ? providerStatus(selectedProvider, authMethod)
    : "not configured";
  const selectedAuthConfigured =
    selectedProvider?.id === "custom-openai" || selectedProviderAuthStatus !== "not configured";
  const apiKeyProviders = providers.filter((provider) =>
    provider.authMethods.some((method) => method.type === "api_key"),
  );
  const accountProviders = providers.filter((provider) =>
    provider.authMethods.some((method) => method.type === "oauth"),
  );
  const customProvider = providers.find((provider) => provider.id === "custom-openai") || null;
  const selectionLocked = busy || authRunning || customRunning;

  useEffect(() => {
    const override = authMethodOverrideRef.current;
    const hasOverride = override?.providerId === selectedProvider?.id;
    if (override && !hasOverride) authMethodOverrideRef.current = null;
    setAuthMethod(
      hasOverride && override
        ? override.method
        : selectedProvider?.authType ||
            selectedProvider?.authMethods.find((method) => method.subscription)?.type ||
            selectedProvider?.authMethods[0]?.type ||
            "api_key",
    );
    setAuthStatus(null);
  }, [selectedProvider]);

  useEffect(() => {
    if (!customProvider) return;
    if (customProvider.custom?.baseUrl) setCustomBaseUrl(customProvider.custom.baseUrl);
    if (customProvider.name) setCustomName(customProvider.name);
  }, [customProvider]);

  const handleProviderChange = useCallback(
    (nextProviderId: string) => {
      setAiProviderId?.(nextProviderId);
      onProviderChange?.(nextProviderId);
    },
    [onProviderChange, setAiProviderId],
  );

  const handleModelChange = useCallback(
    (nextModelId: string) => {
      setAiModelId?.(nextModelId);
      onModelChange?.(nextModelId);
    },
    [onModelChange, setAiModelId],
  );

  const handleAuthMethodChange = useCallback(
    (nextProviderId: string, method: AiAuthMethodInfo["type"]) => {
      authMethodOverrideRef.current = { providerId: nextProviderId, method };
      setAuthMethod(method);
      handleProviderChange(nextProviderId);
    },
    [handleProviderChange],
  );

  const handleAuthenticate = useCallback(async () => {
    if (!providerId || !authenticateAiProvider) return;
    setAuthRunning(true);
    setAuthStatus(null);
    try {
      await authenticateAiProvider(
        providerId,
        authMethod,
        authMethod === "api_key" ? apiKey : undefined,
      );
      setApiKey("");
      setAuthStatus({
        type: "success",
        text: authMethod === "oauth" ? "Signed in successfully." : "API key saved.",
      });
    } catch (error) {
      if (isAbortError(error)) return;
      setAuthStatus({
        type: "error",
        text: error instanceof Error ? error.message : "AI authentication failed",
      });
    } finally {
      setAuthRunning(false);
    }
  }, [apiKey, authMethod, authenticateAiProvider, providerId]);

  const handleLogout = useCallback(async () => {
    if (!providerId || !logoutAiProvider) return;
    setAuthRunning(true);
    setAuthStatus(null);
    try {
      await logoutAiProvider(providerId);
      setAuthStatus({ type: "success", text: "Signed out." });
    } catch (error) {
      setAuthStatus({
        type: "error",
        text: error instanceof Error ? error.message : "AI logout failed",
      });
    } finally {
      setAuthRunning(false);
    }
  }, [logoutAiProvider, providerId]);

  const handleRefresh = useCallback(async () => {
    if (!refreshAiProviders) return;
    try {
      await refreshAiProviders();
    } catch (error) {
      if (!isAbortError(error)) {
        setAuthStatus({
          type: "error",
          text: error instanceof Error ? error.message : "AI providers could not be loaded",
        });
      }
    }
  }, [refreshAiProviders]);

  const handleConfigureCustomProvider = useCallback(async () => {
    if (!configureAiCustomProvider) return;
    setCustomRunning(true);
    setCustomStatus(null);
    try {
      await configureAiCustomProvider({
        name: customName,
        baseUrl: customBaseUrl,
        ...(customApiKey.trim() ? { apiKey: customApiKey } : {}),
      });
      setCustomApiKey("");
      handleProviderChange("custom-openai");
      setCustomStatus({ type: "success", text: "Endpoint saved and models discovered." });
    } catch (error) {
      if (isAbortError(error)) return;
      setCustomStatus({
        type: "error",
        text: error instanceof Error ? error.message : "Custom AI provider setup failed",
      });
    } finally {
      setCustomRunning(false);
    }
  }, [configureAiCustomProvider, customApiKey, customBaseUrl, customName, handleProviderChange]);

  const handleRemoveCustomProvider = useCallback(async () => {
    if (!removeAiCustomProvider) return;
    setCustomRunning(true);
    setCustomStatus(null);
    try {
      await removeAiCustomProvider();
      setCustomStatus({ type: "success", text: "Custom endpoint removed." });
    } catch (error) {
      setCustomStatus({
        type: "error",
        text: error instanceof Error ? error.message : "Custom AI provider removal failed",
      });
    } finally {
      setCustomRunning(false);
    }
  }, [removeAiCustomProvider]);

  const settingsBody = (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-sans font-semibold text-terminal-text">AI providers</h2>
          <p className="mt-1 max-w-2xl text-[10px] font-sans leading-relaxed text-terminal-dim">
            Configure built-in providers or connect an OpenAI-compatible gateway. API keys and
            account sign-ins are shown separately; credentials stay in the local store and are never
            included in provider metadata.
          </p>
        </div>
        {refreshAiProviders && (
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={selectionLocked || aiProvidersLoading}
            className="shrink-0 rounded-lg bg-terminal-surface-2 px-2.5 py-1.5 text-[10px] font-mono text-terminal-dim transition-colors hover:text-terminal-text disabled:opacity-40"
          >
            {aiProvidersLoading ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>

      {aiProvidersError && (
        <div
          role="alert"
          className="rounded-lg bg-terminal-red-subtle px-3 py-2 text-[10px] font-mono text-terminal-red"
        >
          {aiProvidersError}
        </div>
      )}

      {providers.length === 0 && aiProvidersLoading ? (
        <div className="rounded-lg bg-terminal-bg px-3 py-4 text-center text-[10px] font-mono text-terminal-dimmer">
          Loading provider catalog…
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-terminal-border-subtle bg-terminal-bg px-3 py-4 text-center text-[10px] font-mono text-terminal-dimmer">
          Pi AI runtime unavailable. Restart vibe-replay and try again.
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {accountProviders.length > 0 && (
              <div>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-sans font-semibold text-terminal-text">Accounts</h3>
                  <span className="text-[10px] font-mono text-terminal-dimmer">
                    Sign in through the provider
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {accountProviders.map((provider) => {
                    const method = provider.authMethods.find(
                      (candidate) => candidate.type === "oauth",
                    );
                    if (!method) return null;
                    return (
                      <ProviderAuthCard
                        key={`${provider.id}:oauth`}
                        provider={provider}
                        method={method}
                        selected={provider.id === providerId && authMethod === "oauth"}
                        disabled={selectionLocked}
                        onSelect={() => handleAuthMethodChange(provider.id, "oauth")}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {apiKeyProviders.length > 0 && (
              <div>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-sans font-semibold text-terminal-text">API keys</h3>
                  <span className="text-[10px] font-mono text-terminal-dimmer">
                    Use a provider-issued key
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {apiKeyProviders.map((provider) => {
                    const method = provider.authMethods.find(
                      (candidate) => candidate.type === "api_key",
                    );
                    if (!method) return null;
                    return (
                      <ProviderAuthCard
                        key={`${provider.id}:api_key`}
                        provider={provider}
                        method={method}
                        selected={provider.id === providerId && authMethod === "api_key"}
                        disabled={selectionLocked}
                        onSelect={() => handleAuthMethodChange(provider.id, "api_key")}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {selectedProvider && selectedProvider.id !== "custom-openai" && (
            <div className="rounded-lg border border-terminal-border-subtle bg-terminal-bg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-terminal-dim">Authentication</span>
                <span
                  className={`text-[10px] font-mono ${
                    selectedProviderAuthStatus === "not configured"
                      ? "text-terminal-orange"
                      : "text-terminal-green"
                  }`}
                >
                  {selectedProviderAuthStatus}
                </span>
              </div>

              {selectedAuthMethod && (
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
                  <span className="rounded-md bg-terminal-purple-subtle px-2 py-1 text-terminal-purple">
                    {authMethodKind(selectedAuthMethod)}
                  </span>
                  <span className="text-terminal-dimmer">{selectedAuthMethod.label}</span>
                </div>
              )}

              {authMethod === "api_key" &&
                selectedProvider.authMethods.some((method) => method.type === "api_key") && (
                  <div className="flex gap-2">
                    <input
                      aria-label="AI API key"
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="Paste API key"
                      autoComplete="off"
                      disabled={selectionLocked}
                      className={`min-w-0 flex-1 ${INPUT_CLASS}`}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        authRunning ? cancelAiAuthentication?.() : void handleAuthenticate()
                      }
                      disabled={busy || (authRunning ? !cancelAiAuthentication : !apiKey.trim())}
                      className="shrink-0 rounded-lg bg-terminal-purple-subtle px-2.5 py-1.5 text-[10px] font-mono font-semibold text-terminal-purple transition-colors hover:bg-terminal-purple/20 disabled:opacity-40"
                    >
                      {authRunning ? "Cancel" : "Save key"}
                    </button>
                  </div>
                )}

              {authMethod === "oauth" &&
                selectedProvider.authMethods.some((method) => method.type === "oauth") && (
                  <button
                    type="button"
                    onClick={() =>
                      authRunning ? cancelAiAuthentication?.() : void handleAuthenticate()
                    }
                    disabled={busy || (authRunning ? !cancelAiAuthentication : false)}
                    className="w-full rounded-lg bg-terminal-blue-subtle px-3 py-2 text-xs font-mono font-semibold text-terminal-blue transition-colors hover:bg-terminal-blue/20 disabled:opacity-40"
                  >
                    {authRunning
                      ? "Cancel browser sign-in"
                      : selectedProvider.configured && selectedProvider.authType === "oauth"
                        ? "Sign in again"
                        : "Sign in with provider"}
                  </button>
                )}

              {selectedProvider.configured &&
                logoutAiProvider &&
                (selectedProvider.authType === "oauth" ||
                  selectedProvider.authSource === "stored credential") &&
                (!selectedAuthMethod || selectedProvider.authType === selectedAuthMethod.type) && (
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    disabled={selectionLocked}
                    className="text-[10px] font-mono text-terminal-dimmer transition-colors hover:text-terminal-red disabled:opacity-40"
                  >
                    Sign out this provider
                  </button>
                )}

              {authStatus && (
                <div
                  role={authStatus.type === "error" ? "alert" : "status"}
                  className={`text-[10px] font-mono leading-relaxed ${
                    authStatus.type === "error" ? "text-terminal-red" : "text-terminal-green"
                  }`}
                >
                  {authStatus.text}
                </div>
              )}
            </div>
          )}

          {selectedProvider &&
            selectedProvider.models.length > 0 &&
            (selectedAuthConfigured ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-terminal-dim">Model</span>
                <ModelPicker
                  models={selectedProvider.models}
                  value={modelId || ""}
                  onChange={handleModelChange}
                  disabled={selectionLocked}
                />
                {saveAiSelectionAsDefault && (
                  <button
                    type="button"
                    onClick={saveAiSelectionAsDefault}
                    disabled={selectionLocked || !modelId}
                    className={`shrink-0 rounded-lg px-2 py-1.5 text-[10px] font-mono transition-colors disabled:opacity-40 ${
                      providerId === defaultAiProviderId && modelId === defaultAiModelId
                        ? "bg-terminal-green-subtle text-terminal-green"
                        : "bg-terminal-surface-2 text-terminal-dim hover:text-terminal-text"
                    }`}
                  >
                    {providerId === defaultAiProviderId && modelId === defaultAiModelId
                      ? "Default"
                      : "Set default"}
                  </button>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-terminal-border-subtle bg-terminal-bg px-3 py-2.5 text-[10px] font-mono">
                <div className="text-terminal-dim">Connect first to choose a model.</div>
                <div className="mt-1 text-terminal-dimmer">
                  Complete{" "}
                  {selectedAuthMethod ? authMethodKind(selectedAuthMethod) : "authentication"} for{" "}
                  {selectedProvider.name} above.
                </div>
              </div>
            ))}
        </>
      )}

      <div className="rounded-lg border border-terminal-purple/25 bg-terminal-bg p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-mono text-terminal-dim">Custom OpenAI-compatible</span>
          {customProvider && (
            <span className="text-[10px] font-mono text-terminal-green">configured</span>
          )}
        </div>
        <p className="text-[10px] font-mono leading-relaxed text-terminal-dimmer">
          Discover models from <code>/models</code> (or <code>/model</code>) and use Chat
          Completions. Any OpenAI-compatible gateway works — local LiteLLM / Ollama / vLLM or remote{" "}
          <code>https://</code> endpoint. Plain <code>http://</code> is only allowed for loopback (
          <code>127.0.0.1</code> / <code>localhost</code>).
        </p>
        <input
          aria-label="Custom AI provider name"
          type="text"
          value={customName}
          onChange={(event) => setCustomName(event.target.value)}
          placeholder="Provider name"
          disabled={selectionLocked}
          className={INPUT_CLASS}
        />
        <input
          aria-label="Custom AI endpoint"
          type="url"
          value={customBaseUrl}
          onChange={(event) => setCustomBaseUrl(event.target.value)}
          placeholder="http://127.0.0.1:58788/v1"
          autoComplete="off"
          disabled={selectionLocked}
          className={INPUT_CLASS}
        />
        <div className="flex gap-2">
          <input
            aria-label="Custom AI API key"
            type="password"
            value={customApiKey}
            onChange={(event) => setCustomApiKey(event.target.value)}
            placeholder="API key (optional)"
            autoComplete="off"
            disabled={selectionLocked}
            className={`min-w-0 flex-1 ${INPUT_CLASS}`}
          />
          <button
            type="button"
            onClick={() =>
              customRunning ? cancelAiAuthentication?.() : void handleConfigureCustomProvider()
            }
            disabled={busy || (customRunning ? !cancelAiAuthentication : !customBaseUrl.trim())}
            className="shrink-0 rounded-lg bg-terminal-purple-subtle px-2.5 py-1.5 text-[10px] font-mono font-semibold text-terminal-purple transition-colors hover:bg-terminal-purple/20 disabled:opacity-40"
          >
            {customRunning ? "Cancel" : customProvider ? "Update" : "Discover"}
          </button>
        </div>
        {customProvider?.modelError && (
          <div role="alert" className="text-[10px] font-mono leading-relaxed text-terminal-red">
            {customProvider.modelError}
          </div>
        )}
        {customProvider && removeAiCustomProvider && (
          <button
            type="button"
            onClick={() => void handleRemoveCustomProvider()}
            disabled={selectionLocked}
            className="text-[10px] font-mono text-terminal-dimmer transition-colors hover:text-terminal-red disabled:opacity-40"
          >
            Remove custom endpoint and key
          </button>
        )}
        {customStatus && (
          <div
            role={customStatus.type === "error" ? "alert" : "status"}
            className={`text-[10px] font-mono leading-relaxed ${
              customStatus.type === "error" ? "text-terminal-red" : "text-terminal-green"
            }`}
          >
            {customStatus.text}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === "compact") return settingsBody;
  return (
    <section className="rounded-xl bg-terminal-surface p-5 shadow-layer-sm md:p-6">
      {settingsBody}
    </section>
  );
}

export function AiProviderSettingsModal({
  open,
  onClose,
  title = "AI provider settings",
  actions,
  busy,
  onProviderChange,
  onModelChange,
  onOpenSettings,
}: AiProviderSettingsModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  const modal = (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="presentation">
      <button
        type="button"
        aria-label="Close AI provider settings"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <dialog
        open
        aria-modal="true"
        aria-labelledby="ai-provider-settings-title"
        className="relative max-h-[min(90vh,760px)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-terminal-border bg-terminal-bg p-5 shadow-layer-xl md:p-6"
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2
            id="ai-provider-settings-title"
            className="text-base font-sans font-semibold text-terminal-text"
          >
            {title}
          </h2>
          <div className="flex items-center gap-1">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-lg px-2 py-1 text-[10px] font-mono text-terminal-dim transition-colors hover:text-terminal-text"
              >
                Open full Settings
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-2 py-1 text-sm text-terminal-dim transition-colors hover:text-terminal-text"
            >
              ×
            </button>
          </div>
        </div>
        <AiProviderSettings
          actions={actions}
          variant="compact"
          busy={busy}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
        />
      </dialog>
    </div>
  );
  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
}
