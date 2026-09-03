import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiProviderSettings } from "../hooks/useAiProviderSettings";
import { useRemoteDataConsent } from "../hooks/useRemoteDataConsent";
import { navigateTo, navigateToPermalink } from "./dashboard-utils";
import { sanitizeHtml } from "../utils/sanitize";

type AssistantContext = {
  mode: "dashboard" | "replay";
  allowRemoteData?: boolean;
  currentSession?: {
    slug: string;
    provider: string;
    title?: string;
    targetId?: string;
    sceneIndex?: number;
  };
};

type Citation = {
  type: "session" | "scene" | "insight";
  label: string;
  permalink?: string;
  slug?: string;
  provider?: string;
  sessionId?: string;
  targetId?: string;
  sceneIndex?: number;
  project?: string;
  replayAvailable?: boolean;
};

type Action =
  | {
      type: "open_replay";
      label: string;
      slug: string;
      targetId?: string;
      sceneIndex?: number;
      view?: "replay" | "summary" | "export";
      drawer?: "comments" | "ai";
      permalink?: string;
    }
  | {
      type: "open_dashboard";
      label: string;
      tab: "home" | "sessions" | "replays" | "projects" | "insights" | "settings";
      project?: string;
      targetId?: string;
      selected?: string;
      selectedProvider?: string;
      selectedSessionId?: string;
      selectedTargetId?: string;
      settingsSection?: "ai" | "remote" | "more";
      projectView?: "timeline" | "overview" | "files";
      insightsSection?: "overview" | "activity" | "usage" | "coverage" | "workspace";
      query?: string;
      providers?: string[];
      repos?: string[];
      tools?: string[];
      mcpServers?: string[];
      mcpTools?: string[];
      skills?: string[];
      compacted?: boolean;
      archived?: boolean;
      agentRuns?: boolean;
      insightsRange?: "7d" | "30d" | "90d" | "all";
      permalink?: string;
    };

type ToolEvent = { toolName: string; summary?: string; error?: boolean };

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  remoteDataUsed?: boolean;
  toolEvents?: ToolEvent[];
  citations?: Citation[];
  actions?: Action[];
  error?: boolean;
};

interface Props {
  context: AssistantContext;
}

const CHAT_STORAGE_KEY = "vibe-replay-local-assistant-v1";
const CHAT_SIZE_STORAGE_KEY = "vibe-replay-local-assistant-size-v1";
const DEFAULT_PANEL_SIZE = { width: 520, height: 720 };

type PanelSize = typeof DEFAULT_PANEL_SIZE;
type ResizeEdges = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };

type ProviderSetupEmptyStateProps = {
  loading: boolean;
  error: string | null;
  hasConfiguredProvider: boolean;
  hasAvailableProvider: boolean;
  onOpenSettings: () => void;
  onChooseModel: () => void;
  onRetry: () => void;
};

function ProviderSetupEmptyState({
  loading,
  error,
  hasConfiguredProvider,
  hasAvailableProvider,
  onOpenSettings,
  onChooseModel,
  onRetry,
}: ProviderSetupEmptyStateProps) {
  if (loading) {
    return (
      <output
        className="flex min-h-full items-center justify-center py-10 text-xs font-mono text-terminal-dim"
        aria-live="polite"
      >
        <span
          className="mr-2 h-2 w-2 animate-pulse rounded-full bg-terminal-green"
          aria-hidden="true"
        />
        Checking provider setup…
      </output>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-full items-center justify-center py-10">
        <div className="w-full max-w-[360px] rounded-2xl border border-terminal-red/25 bg-terminal-red-subtle/40 p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-terminal-red/15 text-lg text-terminal-red">
              <span aria-hidden="true">!</span>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-terminal-red">
                Provider setup unavailable
              </div>
              <h2 className="mt-1 text-base font-semibold text-terminal-text">
                We couldn’t check your provider
              </h2>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-terminal-dim">
            Ask Replay can’t start until your local provider settings are available. Try again or
            open settings to check the configuration.
          </p>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="flex-1 cursor-pointer rounded-lg border border-terminal-border-subtle bg-terminal-surface px-3 py-2 text-xs font-semibold text-terminal-text transition-colors hover:border-terminal-green/50 hover:text-terminal-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex-1 cursor-pointer rounded-lg bg-terminal-green px-3 py-2 text-xs font-semibold text-terminal-bg transition-colors hover:bg-terminal-green/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
            >
              Open Settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  const needsConnection = !hasConfiguredProvider;
  const needsModel = hasConfiguredProvider && !hasAvailableProvider;

  return (
    <div className="flex min-h-full items-center justify-center py-10">
      <div className="w-full max-w-[360px]">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-terminal-orange/30 bg-terminal-orange-subtle text-xl text-terminal-orange">
            <span aria-hidden="true">✦</span>
          </div>
          <div className="min-w-0 pt-0.5">
            <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-terminal-orange">
              {needsConnection ? "Setup required" : needsModel ? "Almost ready" : "One step left"}
            </div>
            <h2 className="mt-1 text-base font-semibold text-terminal-text [text-wrap:balance]">
              {needsConnection
                ? "Connect a provider to start"
                : needsModel
                  ? "Finish your provider setup"
                  : "Choose a provider & model"}
            </h2>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-terminal-dim">
          {needsConnection
            ? "Ask Replay needs an AI provider before it can search your local sessions or explain usage data."
            : needsModel
              ? "Your provider is connected, but Ask Replay still needs a usable model before you can ask questions."
              : "Choose which configured provider and model should power this chat."}
        </p>

        {needsConnection && (
          <ol className="mt-5 space-y-2.5">
            {[
              ["1", "Connect a provider", "Use an API key, OAuth, or a local runtime."],
              ["2", "Choose a model", "Pick the model you want to use for this chat."],
              ["3", "Start asking", "Search sessions, inspect replays, and explain usage."],
            ].map(([step, title, description]) => (
              <li key={step} className="flex items-start gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-terminal-border-subtle bg-terminal-surface text-[10px] font-mono text-terminal-dim">
                  {step}
                </span>
                <div className="min-w-0 text-xs">
                  <div className="font-medium text-terminal-text">{title}</div>
                  <div className="mt-0.5 leading-relaxed text-terminal-dim">{description}</div>
                </div>
              </li>
            ))}
          </ol>
        )}

        <button
          type="button"
          onClick={needsConnection || needsModel ? onOpenSettings : onChooseModel}
          className="mt-6 flex w-full cursor-pointer items-center justify-between rounded-xl bg-terminal-green px-3.5 py-3 text-left text-xs font-semibold text-terminal-bg transition-colors hover:bg-terminal-green/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/60 focus-visible:ring-offset-2 focus-visible:ring-offset-terminal-bg"
        >
          <span>
            {needsConnection
              ? "Set Up an AI Provider"
              : needsModel
                ? "Open Provider Settings"
                : "Choose Provider & Model"}
          </span>
          <span aria-hidden="true" className="text-sm">
            →
          </span>
        </button>
        <p className="mt-3 text-center text-[10px] leading-relaxed font-mono text-terminal-dimmer">
          Credentials stay in the local provider store. Ask Replay is read-only.
        </p>
      </div>
    </div>
  );
}

function readPanelSize(): PanelSize {
  try {
    const raw = localStorage.getItem(CHAT_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_PANEL_SIZE;
    const value = JSON.parse(raw) as Partial<PanelSize>;
    if (typeof value.width !== "number" || typeof value.height !== "number") {
      return DEFAULT_PANEL_SIZE;
    }
    return {
      width: Math.max(320, Math.round(value.width)),
      height: Math.max(360, Math.round(value.height)),
    };
  } catch {
    return DEFAULT_PANEL_SIZE;
  }
}

function readStoredMessages(): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((message): message is ChatMessage => {
      if (!message || typeof message !== "object") return false;
      const candidate = message as Partial<ChatMessage>;
      return (
        (candidate.role === "user" || candidate.role === "assistant") &&
        typeof candidate.content === "string"
      );
    });
  } catch {
    return [];
  }
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    search_sessions: "Searching local sessions",
    get_session_summary: "Reading session summary",
    get_session_content: "Reading replay scenes",
    get_scene: "Reading replay scene",
    get_session_annotations: "Reading replay annotations",
    get_session_overlays: "Reading replay AI edits",
    get_data_status: "Checking local data status",
    prepare_user_action: "Preparing a user action link",
    get_insights: "Reading local insights",
    get_usage_breakdown: "Reading usage breakdown",
    get_compaction_diagnostics: "Diagnosing compaction events",
    open_replay: "Preparing replay navigation",
    open_dashboard: "Preparing dashboard navigation",
  };
  return labels[name] || name.replaceAll("_", " ");
}

function isAction(value: unknown): value is Action {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<Action>;
  if (action.type === "open_replay") return typeof action.slug === "string";
  return (
    action.type === "open_dashboard" &&
    typeof action.tab === "string" &&
    ["home", "sessions", "replays", "projects", "insights", "settings"].includes(action.tab)
  );
}

function isCitation(value: unknown): value is Citation {
  if (!value || typeof value !== "object") return false;
  const citation = value as Partial<Citation>;
  return (
    (citation.type === "session" || citation.type === "scene" || citation.type === "insight") &&
    typeof citation.label === "string"
  );
}

function AssistantMarkdown({ content }: { content: string }) {
  const html = useMemo(() => sanitizeHtml(marked.parse(content) as string), [content]);
  return (
    <div
      className="prose-terminal text-sm text-terminal-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function navigateAction(action: Action): void {
  if (action.permalink) {
    navigateToPermalink(action.permalink);
    return;
  }
  if (action.type === "open_replay") {
    navigateTo({
      session: action.slug,
      targetId: action.targetId || null,
      s: action.sceneIndex === undefined ? null : String(action.sceneIndex),
      v: action.view && action.view !== "replay" ? action.view : null,
      drawer: action.drawer || null,
    });
    return;
  }
  navigateTo({
    view: "dashboard",
    session: null,
    tab: action.tab,
    project: action.project || null,
    targetId: action.targetId || null,
    selected: action.selected || null,
    selectedProvider: action.selectedProvider || null,
    selectedSessionId: action.selectedSessionId || null,
    selectedTargetId: action.selectedTargetId || null,
    settingsSection: action.settingsSection || null,
    projectView: action.projectView || null,
    insightsSection: action.insightsSection || null,
    q: action.query || null,
    provider: action.providers?.length ? action.providers : null,
    repo: action.repos?.length ? action.repos : null,
    tool: action.tools?.length ? action.tools : null,
    mcp: action.mcpServers?.length ? action.mcpServers : null,
    mcpTool: action.mcpTools?.length ? action.mcpTools : null,
    skill: action.skills?.length ? action.skills : null,
    compacted: action.compacted ? "true" : null,
    archived: action.archived ? "true" : null,
    agentRuns: action.agentRuns ? "true" : null,
    insightsRange:
      action.insightsRange && action.insightsRange !== "all" ? action.insightsRange : null,
  });
}

function navigateCitation(citation: Citation): void {
  if (citation.permalink) {
    navigateToPermalink(citation.permalink);
    return;
  }
  if (citation.type === "session") {
    if (citation.replayAvailable !== false && citation.slug) {
      navigateTo({
        session: citation.slug,
        targetId: citation.targetId || null,
        s: citation.sceneIndex === undefined ? null : String(citation.sceneIndex),
      });
      return;
    }
    if (citation.slug) {
      window.dispatchEvent(
        new CustomEvent("vibe-open-session", {
          detail: {
            slug: citation.slug,
            provider: citation.provider,
            sessionId: citation.sessionId,
            location: citation.targetId
              ? { kind: "ssh", id: citation.targetId, label: citation.targetId }
              : undefined,
          },
        }),
      );
      return;
    }
    navigateTo({
      view: "dashboard",
      session: null,
      tab: "sessions",
      targetId: citation.targetId || null,
    });
    return;
  }
  if (citation.slug) {
    navigateTo({
      session: citation.slug,
      targetId: citation.targetId || null,
      s: citation.sceneIndex === undefined ? null : String(citation.sceneIndex),
    });
  } else {
    navigateTo({
      view: "dashboard",
      session: null,
      tab: "insights",
      project: citation.project || null,
      targetId: citation.targetId || null,
    });
  }
}

async function consumeSse(
  response: Response,
  onEvent: (payload: Record<string, unknown>) => void,
): Promise<void> {
  if (!response.body) throw new Error("Assistant stream is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeBlock = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data) return;
    try {
      const value = JSON.parse(data) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        onEvent(value as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed keepalive chunks; the server only sends JSON data.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) consumeBlock(block);
      if (done) break;
    }
    if (buffer.trim()) consumeBlock(buffer);
  } finally {
    reader.releaseLock();
  }
}

export default function LocalChatAssistant({ context }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(readStoredMessages);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [providerLabel, setProviderLabel] = useState<string | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelSize, setPanelSize] = useState<PanelSize>(DEFAULT_PANEL_SIZE);
  const [resizing, setResizing] = useState(false);
  const [nudge, setNudge] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const resizeStartRef = useRef<
    { x: number; y: number; width: number; height: number; edges: ResizeEdges } | undefined
  >(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const providerSettings = useAiProviderSettings(true);
  const { allowRemoteData, hasConfiguredRemoteSource, remoteSourcesLoading } =
    useRemoteDataConsent(true);
  const { refreshAiProviders } = providerSettings;
  const availableProviders = providerSettings.aiProviders.filter(
    (provider) => provider.configured && provider.models.length > 0,
  );
  const defaultProvider = providerSettings.aiProviders.find(
    (provider) => provider.id === providerSettings.defaultAiProviderId,
  );
  const defaultModel = defaultProvider?.models.find(
    (model) => model.id === providerSettings.defaultAiModelId,
  );
  const defaultSelectionReady = Boolean(defaultProvider?.configured && defaultModel);
  const chatProviderId = defaultSelectionReady
    ? providerSettings.defaultAiProviderId
    : providerSettings.aiProviderId;
  const chatModelId = defaultSelectionReady
    ? providerSettings.defaultAiModelId
    : providerSettings.aiModelId;
  const selectedProvider = providerSettings.aiProviders.find(
    (provider) => provider.id === chatProviderId,
  );
  const selectedModel = selectedProvider?.models.find((model) => model.id === chatModelId);
  const providerReady = Boolean(selectedProvider?.configured && selectedModel);
  const hasConfiguredProvider = providerSettings.aiProviders.some(
    (provider) => provider.configured,
  );
  const providerSetupMessage = providerSettings.aiProvidersError
    ? "Provider setup is unavailable."
    : !hasConfiguredProvider
      ? "Set up an AI provider to continue."
      : availableProviders.length === 0
        ? "Choose a usable model to continue."
        : "Choose a provider and model to continue.";
  const providerSetupAction = hasConfiguredProvider
    ? "Open provider settings"
    : "Set up an AI provider";
  const remoteSession = Boolean(context.currentSession?.targetId);
  const remoteDataAvailable = remoteSession || hasConfiguredRemoteSource;
  const remoteDataEnabled = allowRemoteData && remoteDataAvailable;
  const retryProviderSetup = useCallback(async () => {
    try {
      await refreshAiProviders?.();
    } catch {
      // The provider hook exposes the error state; retry should not create an
      // unhandled rejection in the chat surface.
    }
  }, [refreshAiProviders]);

  useEffect(() => {
    setPanelSize(readPanelSize());
  }, []);

  // Subtle periodic nudge so first-time users notice the FAB is tappable.
  // Respects prefers-reduced-motion and pauses while open/hovered.
  useEffect(() => {
    if (open) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setNudge(true);
      window.setTimeout(() => setNudge(false), 650);
    }, 5200);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_SIZE_STORAGE_KEY, JSON.stringify(panelSize));
    } catch {
      // The size is a convenience; storage failures must not block chat.
    }
  }, [panelSize]);

  useEffect(() => {
    if (!resizing) return;
    const onPointerMove = (event: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const maxWidth = Math.max(320, window.innerWidth - 32);
      const maxHeight = Math.max(360, window.innerHeight - 32);
      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      const widthDelta = start.edges.left ? -deltaX : start.edges.right ? deltaX : 0;
      const heightDelta = start.edges.top ? -deltaY : start.edges.bottom ? deltaY : 0;
      setPanelSize({
        width: Math.min(maxWidth, Math.max(320, start.width + widthDelta)),
        height: Math.min(maxHeight, Math.max(360, start.height + heightDelta)),
      });
    };
    const stopResizing = () => {
      resizeStartRef.current = undefined;
      setResizing(false);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
    window.addEventListener("pointercancel", stopResizing, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [resizing]);

  const beginResize = (
    event: { clientX: number; clientY: number; preventDefault: () => void },
    edges: ResizeEdges,
  ) => {
    event.preventDefault();
    resizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: panelSize.width,
      height: panelSize.height,
      edges,
    };
    setResizing(true);
  };

  useEffect(() => {
    // A selection can change in AI Studio or Settings while Ask Replay stays
    // mounted. Do not keep showing the model used by an older answer.
    setProviderLabel(null);
  }, [chatModelId, chatProviderId]);

  useEffect(() => {
    setSwitchOpen(false);
  }, [context.currentSession?.slug, context.currentSession?.targetId]);

  useEffect(() => {
    try {
      sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      // Chat history is a convenience; storage failures must not block chat.
    }
  }, [messages]);

  useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, activeTool]);

  const clearConversation = useCallback(() => {
    if (running) return;
    setMessages([]);
    setError(null);
    try {
      sessionStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }, [running]);

  const sendMessage = useCallback(async () => {
    const content = input.trim();
    if (!content || running || !providerReady) return;
    const userMessage: ChatMessage = { role: "user", content };
    const nextMessages = [...messages, userMessage].slice(-12);
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setRunning(true);
    setActiveTool(null);
    const toolEvents: ToolEvent[] = [];
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const params = new URLSearchParams(window.location.search);
      const body = {
        messages: nextMessages
          .filter((message) => remoteDataEnabled || !message.remoteDataUsed)
          .map(({ role, content: messageContent }) => ({
            role,
            content: messageContent,
          })),
        context: {
          ...context,
          allowRemoteData: remoteDataEnabled,
          tab: params.get("tab") || undefined,
          project: params.get("project") || undefined,
          currentSession: context.currentSession
            ? {
                ...context.currentSession,
                sceneIndex: (() => {
                  const rawValue = params.get("s");
                  const value = Number(rawValue);
                  return rawValue !== null && /^\d+$/.test(rawValue) && Number.isSafeInteger(value)
                    ? value
                    : context.currentSession?.sceneIndex;
                })(),
              }
            : undefined,
        },
        ...(chatProviderId ? { providerId: chatProviderId } : {}),
        ...(chatModelId ? { modelId: chatModelId } : {}),
      };
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `Assistant request failed (${response.status})`);
      }

      await consumeSse(response, (payload) => {
        if (payload.type === "start") {
          const name = typeof payload.providerName === "string" ? payload.providerName : null;
          const model = typeof payload.modelId === "string" ? payload.modelId : null;
          setProviderLabel(name && model ? `Default · ${name} · ${model}` : name);
        } else if (payload.type === "tool_start") {
          const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
          setActiveTool(name);
        } else if (payload.type === "tool_end") {
          const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
          toolEvents.push({
            toolName: name,
            summary: typeof payload.summary === "string" ? payload.summary : undefined,
            error: payload.error === true,
          });
          setActiveTool(null);
        } else if (payload.type === "message_delta") {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          if (!delta) return;
          setMessages((current) => {
            const last = current[current.length - 1];
            if (last?.role === "assistant" && last.streaming) {
              return [...current.slice(0, -1), { ...last, content: last.content + delta }];
            }
            return [...current, { role: "assistant", content: delta, streaming: true }];
          });
        } else if (payload.type === "error") {
          throw new Error(
            typeof payload.message === "string" ? payload.message : "Assistant failed",
          );
        } else if (payload.type === "done") {
          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: typeof payload.message === "string" ? payload.message : "No response.",
            remoteDataUsed: payload.remoteDataUsed === true,
            toolEvents: toolEvents.length > 0 ? [...toolEvents] : undefined,
            citations: Array.isArray(payload.citations)
              ? payload.citations.filter(isCitation)
              : undefined,
            actions: Array.isArray(payload.actions) ? payload.actions.filter(isAction) : undefined,
          };
          setMessages((current) => {
            const last = current[current.length - 1];
            if (last?.role === "assistant" && last.streaming) {
              return [...current.slice(0, -1), assistantMessage].slice(-40);
            }
            return [...current, assistantMessage].slice(-40);
          });
        }
      });
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages((current) => {
          const last = current[current.length - 1];
          if (last?.role === "assistant" && last.streaming) {
            return [...current.slice(0, -1), { ...last, streaming: false, error: true }];
          }
          return [...current, { role: "assistant", content: "Request cancelled.", error: true }];
        });
      } else {
        setMessages((current) => {
          const last = current[current.length - 1];
          return last?.role === "assistant" && last.streaming
            ? [...current.slice(0, -1), { ...last, streaming: false, error: true }]
            : current;
        });
        setError(err instanceof Error ? err.message : "Assistant request failed");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setActiveTool(null);
      setRunning(false);
    }
  }, [
    context,
    input,
    messages,
    providerReady,
    chatModelId,
    chatProviderId,
    running,
    remoteDataEnabled,
  ]);

  const cancel = () => controllerRef.current?.abort();
  const openProviderSettings = () =>
    navigateTo({ view: "dashboard", session: null, tab: "settings" });
  const providerStatus = providerSettings.aiProvidersLoading
    ? "Checking provider setup…"
    : providerSettings.aiProvidersError
      ? "Provider setup unavailable"
      : providerReady && selectedProvider && selectedModel
        ? `${defaultSelectionReady ? "Default" : "Selected"} · ${selectedProvider.name} · ${selectedModel.name || selectedModel.id}`
        : !hasConfiguredProvider
          ? "Setup required"
          : availableProviders.length === 0
            ? "Model setup required"
            : "Choose provider & model";
  const canChooseModel = availableProviders.length > 0;

  const chooseDefaultProvider = (providerId: string) => {
    const provider = availableProviders.find((candidate) => candidate.id === providerId);
    const modelId = provider?.models[0]?.id;
    if (!modelId) return;
    providerSettings.saveAiSelectionAsDefault?.({ providerId, modelId });
    setProviderLabel(null);
  };
  const chooseDefaultModel = (modelId: string) => {
    if (!chatProviderId) return;
    providerSettings.saveAiSelectionAsDefault?.({ providerId: chatProviderId, modelId });
    setProviderLabel(null);
  };

  return (
    <div className={`fixed right-3 bottom-3 z-[60] font-sans ${resizing ? "select-none" : ""}`}>
      {open && (
        <aside
          className="relative mb-3 flex max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-terminal-border-subtle bg-terminal-bg shadow-layer-xl"
          style={{
            width: panelSize.width,
            height: panelSize.height,
            minWidth: "min(320px, calc(100vw - 2rem))",
            minHeight: "min(360px, calc(100vh - 2rem))",
          }}
        >
          <header className="flex shrink-0 items-center justify-between border-b border-terminal-border-subtle bg-terminal-surface/70 px-4 py-3 backdrop-blur-md">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-terminal-text">
                <span className="text-terminal-green">✦</span>
                Ask Replay
                <span className="rounded-full border border-terminal-green/25 bg-terminal-green-subtle px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-terminal-green">
                  Local
                </span>
              </div>
              <div
                className={`mt-1 flex items-center gap-1.5 truncate text-[10px] font-mono ${providerReady ? "text-terminal-dim" : "text-terminal-orange"}`}
                aria-live="polite"
              >
                {!providerReady && !providerSettings.aiProvidersLoading && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-terminal-orange"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">
                  {providerReady && providerLabel ? providerLabel : providerStatus}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (canChooseModel) {
                    setSwitchOpen((current) => !current);
                  } else {
                    openProviderSettings();
                  }
                }}
                disabled={providerSettings.aiProvidersLoading}
                className="cursor-pointer rounded-md px-2 py-1 text-[10px] font-mono text-terminal-dim transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
                aria-expanded={canChooseModel ? switchOpen : undefined}
              >
                {canChooseModel ? (providerReady ? "Switch model" : "Choose model") : "Set up"}
              </button>
              <button
                type="button"
                onClick={clearConversation}
                disabled={running || messages.length === 0}
                className="cursor-pointer rounded-md px-2 py-1 text-[10px] font-mono text-terminal-dim transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="cursor-pointer rounded-md px-2 py-1 text-terminal-dim transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
                aria-label="Close Ask Replay"
              >
                ×
              </button>
            </div>
          </header>

          {switchOpen && (
            <div className="shrink-0 space-y-2 border-b border-terminal-border-subtle bg-terminal-surface/40 px-4 py-3">
              <div className="flex gap-2">
                <select
                  aria-label="AI provider"
                  value={chatProviderId || ""}
                  onChange={(event) => {
                    chooseDefaultProvider(event.target.value);
                  }}
                  className="min-w-0 flex-1 cursor-pointer rounded-lg border border-terminal-border-subtle bg-terminal-bg px-2 py-1.5 text-[10px] font-mono text-terminal-text outline-none focus:border-terminal-green/50"
                >
                  {availableProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="AI model"
                  value={chatModelId || ""}
                  onChange={(event) => {
                    chooseDefaultModel(event.target.value);
                  }}
                  className="min-w-0 flex-[1.4] cursor-pointer rounded-lg border border-terminal-border-subtle bg-terminal-bg px-2 py-1.5 text-[10px] font-mono text-terminal-text outline-none focus:border-terminal-green/50"
                >
                  {(selectedProvider?.models || []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-[9px] font-mono text-terminal-dimmer">
                Default model is shared across Ask Replay and AI Studio. Credentials stay in the
                local provider store.
              </div>
            </div>
          )}

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.length === 0 &&
              (providerSettings.aiProvidersLoading ||
              providerSettings.aiProvidersError ||
              !providerReady ? (
                <ProviderSetupEmptyState
                  loading={providerSettings.aiProvidersLoading}
                  error={providerSettings.aiProvidersError}
                  hasConfiguredProvider={hasConfiguredProvider}
                  hasAvailableProvider={availableProviders.length > 0}
                  onOpenSettings={openProviderSettings}
                  onChooseModel={() => setSwitchOpen(true)}
                  onRetry={retryProviderSetup}
                />
              ) : (
                <div className="pt-8 text-center">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-terminal-green-subtle text-xl text-terminal-green">
                    <span aria-hidden="true">✦</span>
                  </div>
                  <h2 className="text-sm font-semibold text-terminal-text [text-wrap:balance]">
                    What would you like to find?
                  </h2>
                  <div className="mx-auto mt-2 max-w-[280px] text-xs leading-relaxed text-terminal-dim">
                    Search local sessions, explain usage data, read replay scenes, and open the
                    relevant view.
                  </div>
                  <div className="mt-5 space-y-2 text-left">
                    {[
                      "Find my most recent sessions",
                      "Why was my last session expensive?",
                      "Which sessions used MCP or tools?",
                      "How complete are my Insights for the last 30 days?",
                      "Show comments and AI edits in this replay",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => setInput(suggestion)}
                        className="block w-full cursor-pointer rounded-lg border border-terminal-border-subtle bg-terminal-surface/50 px-3 py-2 text-left text-xs text-terminal-dim transition-colors hover:border-terminal-green/40 hover:text-terminal-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

            {messages.map((message, index) => (
              <div
                key={`${index}-${message.role}`}
                className={message.role === "user" ? "flex justify-end" : ""}
              >
                <div
                  className={`max-w-[94%] rounded-xl px-3 py-2.5 ${
                    message.role === "user"
                      ? "bg-terminal-green-subtle text-terminal-text"
                      : message.error
                        ? "border border-terminal-red/30 bg-terminal-red-subtle text-terminal-red"
                        : "border border-terminal-border-subtle bg-terminal-surface/45"
                  }`}
                >
                  {message.role === "assistant" ? (
                    <>
                      <AssistantMarkdown content={message.content} />
                      {message.streaming && (
                        <span className="animate-pulse text-terminal-green" aria-hidden="true">
                          ▌
                        </span>
                      )}
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap text-sm text-terminal-text">
                      {message.content}
                    </div>
                  )}

                  {message.remoteDataUsed && (
                    <div className="mt-2 text-[9px] font-mono text-terminal-yellow">
                      SSH session data was shared for this answer.
                    </div>
                  )}

                  {message.toolEvents && message.toolEvents.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-terminal-border-subtle pt-2">
                      {message.toolEvents.map((event, eventIndex) => (
                        <div
                          key={`${event.toolName}-${eventIndex}`}
                          className="text-[10px] font-mono text-terminal-dim"
                        >
                          <span
                            className={event.error ? "text-terminal-red" : "text-terminal-green"}
                          >
                            {event.error ? "!" : "✓"}
                          </span>{" "}
                          {toolLabel(event.toolName)}
                          {event.summary ? ` — ${event.summary}` : ""}
                        </div>
                      ))}
                    </div>
                  )}

                  {message.citations && message.citations.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-terminal-border-subtle pt-2">
                      {message.citations.slice(0, 8).map((citation, citationIndex) => (
                        <button
                          key={`${citation.label}-${citationIndex}`}
                          type="button"
                          onClick={() => navigateCitation(citation)}
                          className="max-w-full cursor-pointer truncate rounded-full border border-terminal-blue/25 bg-terminal-blue-subtle px-2 py-1 text-[10px] font-mono text-terminal-blue transition-colors hover:border-terminal-blue/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-blue/50"
                          title={citation.label}
                        >
                          {citation.type === "scene" ? "scene · " : ""}
                          {citation.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {message.actions && message.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.actions.map((action, actionIndex) => (
                        <button
                          key={`${action.type}-${actionIndex}`}
                          type="button"
                          onClick={() => navigateAction(action)}
                          title={action.permalink || undefined}
                          className="cursor-pointer rounded-lg bg-terminal-green px-2.5 py-1.5 text-[10px] font-semibold text-terminal-bg transition-colors hover:bg-terminal-green/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {running && (
              <div className="flex items-center gap-2 text-xs font-mono text-terminal-dim">
                <span className="h-2 w-2 animate-pulse rounded-full bg-terminal-green" />
                {activeTool ? toolLabel(activeTool) : "Streaming"}…
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-terminal-red-subtle px-3 py-2 text-xs text-terminal-red">
                {error}
              </div>
            )}
          </div>

          <form
            className="shrink-0 border-t border-terminal-border-subtle bg-terminal-surface/40 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            {messages.length > 0 && !providerSettings.aiProvidersLoading && !providerReady && (
              <output
                className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-terminal-orange/30 bg-terminal-orange-subtle px-3 py-2.5 text-[10px] font-mono leading-relaxed text-terminal-orange"
                aria-live="polite"
              >
                <span className="min-w-0">{providerSetupMessage}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (providerSettings.aiProvidersError) {
                      void retryProviderSetup();
                    } else if (canChooseModel) {
                      setSwitchOpen(true);
                    } else {
                      openProviderSettings();
                    }
                  }}
                  className="shrink-0 cursor-pointer font-semibold underline underline-offset-2 transition-colors hover:text-terminal-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
                >
                  {providerSettings.aiProvidersError
                    ? "Retry"
                    : canChooseModel
                      ? "Choose model"
                      : providerSetupAction}
                </button>
              </output>
            )}
            <div className="flex items-end gap-2 rounded-xl border border-terminal-border-subtle bg-terminal-bg px-3 py-2 focus-within:border-terminal-green/50 focus-within:ring-1 focus-within:ring-terminal-green/20">
              <textarea
                name="assistant-question"
                autoComplete="off"
                aria-label="Ask about your sessions"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={2}
                disabled={running || !providerReady}
                placeholder={
                  providerReady
                    ? "Ask about your sessions…"
                    : providerSettings.aiProvidersLoading
                      ? "Checking provider setup…"
                      : providerSettings.aiProvidersError
                        ? "Provider setup unavailable…"
                        : hasConfiguredProvider
                          ? "Choose a provider and model to start…"
                          : "Set up a provider to start…"
                }
                className="max-h-28 min-h-10 flex-1 resize-none bg-transparent text-sm text-terminal-text outline-none placeholder:text-terminal-dimmer disabled:opacity-50"
              />
              {running ? (
                <button
                  type="button"
                  onClick={cancel}
                  className="cursor-pointer rounded-lg bg-terminal-red-subtle px-2.5 py-1.5 text-[10px] font-semibold text-terminal-red transition-colors hover:bg-terminal-red/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-red/50"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() || !providerReady}
                  className="cursor-pointer rounded-lg bg-terminal-green px-2.5 py-1.5 text-[10px] font-semibold text-terminal-bg transition-colors hover:bg-terminal-green/80 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
                >
                  Ask
                </button>
              )}
            </div>
            {providerReady && remoteDataAvailable && !remoteDataEnabled && (
              <div className="mt-2 flex items-start justify-between gap-3 rounded-lg border border-terminal-yellow/25 bg-terminal-yellow-subtle px-2.5 py-2 text-[9px] leading-relaxed font-mono text-terminal-yellow">
                <span>
                  {remoteSession
                    ? "This SSH replay is hidden from Ask Replay until SSH data is enabled in Settings."
                    : "SSH session data is hidden from Ask Replay until enabled in Settings."}
                </span>
                <button
                  type="button"
                  onClick={openProviderSettings}
                  className="shrink-0 cursor-pointer font-semibold underline underline-offset-2 transition-colors hover:text-terminal-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
                >
                  Open Settings
                </button>
              </div>
            )}
            <div className="mt-2 flex items-center justify-between text-[9px] font-mono text-terminal-dimmer">
              <span>
                Read-only ·{" "}
                {!providerReady
                  ? "provider setup required"
                  : remoteSourcesLoading && !remoteSession
                    ? "checking source settings"
                    : remoteDataEnabled
                      ? "SSH data enabled"
                      : remoteDataAvailable
                        ? "SSH data hidden"
                        : "local sessions only"}
              </span>
              <button
                type="button"
                onClick={openProviderSettings}
                className="cursor-pointer transition-colors hover:text-terminal-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50"
              >
                Provider settings
              </button>
            </div>
            <button
              type="button"
              aria-label="Resize Ask Replay from the top-left corner"
              title="Drag to resize"
              onPointerDown={(event) => beginResize(event, { left: true, top: true })}
              className="absolute top-0 left-0 z-10 h-4 w-4 cursor-nwse-resize touch-none rounded text-terminal-dimmer hover:text-terminal-text"
            >
              <span aria-hidden="true">⋰</span>
            </button>
            <button
              type="button"
              aria-label="Resize Ask Replay from the top edge"
              onPointerDown={(event) => beginResize(event, { top: true })}
              className="absolute top-0 right-4 left-4 z-10 h-2 cursor-ns-resize touch-none"
            />
            <button
              type="button"
              aria-label="Resize Ask Replay from the top-right corner"
              onPointerDown={(event) => beginResize(event, { right: true, top: true })}
              className="absolute top-0 right-0 z-10 h-4 w-4 cursor-nesw-resize touch-none rounded"
            />
            <button
              type="button"
              aria-label="Resize Ask Replay from the left edge"
              onPointerDown={(event) => beginResize(event, { left: true })}
              className="absolute top-4 bottom-4 left-0 z-10 w-2 cursor-ew-resize touch-none"
            />
            <button
              type="button"
              aria-label="Resize Ask Replay from the right edge"
              onPointerDown={(event) => beginResize(event, { right: true })}
              className="absolute top-4 right-0 bottom-4 z-10 w-2 cursor-ew-resize touch-none"
            />
            <button
              type="button"
              aria-label="Resize Ask Replay from the bottom-left corner"
              onPointerDown={(event) => beginResize(event, { left: true, bottom: true })}
              className="absolute bottom-0 left-0 z-10 h-4 w-4 cursor-nesw-resize touch-none rounded"
            />
            <button
              type="button"
              aria-label="Resize Ask Replay from the bottom edge"
              onPointerDown={(event) => beginResize(event, { bottom: true })}
              className="absolute right-4 bottom-0 left-4 z-10 h-2 cursor-ns-resize touch-none"
            />
            <button
              type="button"
              aria-label="Resize Ask Replay from the bottom-right corner"
              onPointerDown={(event) => beginResize(event, { right: true, bottom: true })}
              className="absolute right-0 bottom-0 z-10 h-4 w-4 cursor-nwse-resize touch-none rounded text-terminal-dimmer hover:text-terminal-text"
            >
              <span aria-hidden="true">⋰</span>
            </button>
          </form>
        </aside>
      )}

      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          onMouseEnter={() => setNudge(false)}
          aria-label="Ask Replay"
          title="Ask Replay — local assistant"
          className={`flex cursor-pointer items-center gap-1 rounded-full border bg-terminal-surface/85 px-2.5 py-1.5 text-[11px] font-semibold tracking-tight shadow-layer-md backdrop-blur-md transition-[transform,box-shadow,border-color,background-color,color] duration-300 hover:border-terminal-green/60 hover:bg-terminal-surface hover:text-terminal-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-green/50 ${nudge ? "scale-[1.04] border-terminal-green/55 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]" : "scale-100 border-terminal-green/30 text-terminal-text"}`}
        >
          <span
            className={`leading-none transition-transform ${nudge ? "scale-110" : ""} text-terminal-green`}
          >
            ✦
          </span>
          <span className="leading-none">Ask</span>
          <span
            className={`ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${nudge ? "animate-ping bg-terminal-green" : "bg-terminal-green/80"}`}
            aria-hidden="true"
          />
        </button>
      )}
    </div>
  );
}
