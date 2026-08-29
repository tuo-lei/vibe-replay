import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiProviderSettings } from "../hooks/useAiProviderSettings";
import { navigateTo } from "./dashboard-utils";
import { sanitizeHtml } from "../utils/sanitize";

type AssistantContext = {
  mode: "dashboard" | "replay";
  allowRemoteData?: boolean;
  currentSession?: {
    slug: string;
    provider: string;
    title?: string;
    targetId?: string;
  };
};

type Citation = {
  type: "session" | "scene" | "insight";
  label: string;
  slug?: string;
  targetId?: string;
  sceneIndex?: number;
  project?: string;
};

type Action =
  | {
      type: "open_replay";
      label: string;
      slug: string;
      targetId?: string;
      sceneIndex?: number;
    }
  | {
      type: "open_dashboard";
      label: string;
      tab: "home" | "sessions" | "replays" | "projects" | "insights";
      project?: string;
      targetId?: string;
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
    get_insights: "Reading local insights",
    get_usage_breakdown: "Reading usage breakdown",
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
    ["home", "sessions", "replays", "projects", "insights"].includes(action.tab)
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
  if (action.type === "open_replay") {
    navigateTo({
      session: action.slug,
      targetId: action.targetId || null,
      s: action.sceneIndex === undefined ? null : String(action.sceneIndex),
    });
    return;
  }
  navigateTo({
    view: "dashboard",
    session: null,
    tab: action.tab,
    project: action.project || null,
    targetId: action.targetId || null,
  });
}

function navigateCitation(citation: Citation): void {
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
  const [allowRemoteData, setAllowRemoteData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelSize, setPanelSize] = useState<PanelSize>(DEFAULT_PANEL_SIZE);
  const [resizing, setResizing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const resizeStartRef = useRef<
    { x: number; y: number; width: number; height: number } | undefined
  >(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const providerSettings = useAiProviderSettings(true);
  const selectedProvider = providerSettings.aiProviders.find(
    (provider) => provider.id === providerSettings.aiProviderId,
  );
  const availableProviders = providerSettings.aiProviders.filter(
    (provider) => provider.configured && provider.models.length > 0,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.id === providerSettings.aiModelId,
  );
  const providerReady = Boolean(selectedProvider?.configured && selectedModel);
  const hasConfiguredProvider = providerSettings.aiProviders.some(
    (provider) => provider.configured,
  );
  const providerSetupMessage = !hasConfiguredProvider
    ? "No AI provider is configured yet."
    : availableProviders.length === 0
      ? "Your configured provider has no usable model yet."
      : "Select a provider and model in AI Studio.";
  const providerSetupAction = hasConfiguredProvider
    ? "Open provider settings →"
    : "Set up an AI provider →";
  const remoteSession = Boolean(context.currentSession?.targetId);

  useEffect(() => {
    setPanelSize(readPanelSize());
  }, []);

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
      setPanelSize({
        width: Math.min(maxWidth, Math.max(320, start.width - (event.clientX - start.x))),
        height: Math.min(maxHeight, Math.max(360, start.height - (event.clientY - start.y))),
      });
    };
    const stopResizing = () => {
      resizeStartRef.current = undefined;
      setResizing(false);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResizing);
    };
  }, [resizing]);

  useEffect(() => {
    // A selection can change in AI Studio or Settings while Ask Replay stays
    // mounted. Do not keep showing the model used by an older answer.
    setProviderLabel(null);
  }, [providerSettings.aiModelId, providerSettings.aiProviderId]);

  useEffect(() => {
    setAllowRemoteData(false);
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
          .filter((message) => allowRemoteData || !message.remoteDataUsed)
          .map(({ role, content: messageContent }) => ({
            role,
            content: messageContent,
          })),
        context: {
          ...context,
          allowRemoteData,
          tab: params.get("tab") || undefined,
          project: params.get("project") || undefined,
        },
        ...(providerSettings.aiProviderId ? { providerId: providerSettings.aiProviderId } : {}),
        ...(providerSettings.aiModelId ? { modelId: providerSettings.aiModelId } : {}),
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
          setProviderLabel(name && model ? `${name} · ${model}` : name);
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
    allowRemoteData,
    input,
    messages,
    providerReady,
    providerSettings.aiModelId,
    providerSettings.aiProviderId,
    running,
  ]);

  const cancel = () => controllerRef.current?.abort();

  return (
    <div className={`fixed right-4 bottom-4 z-[60] font-sans ${resizing ? "select-none" : ""}`}>
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
              <div className="mt-1 truncate text-[10px] font-mono text-terminal-dim">
                {providerLabel ||
                  (providerReady && selectedProvider && selectedModel
                    ? `${selectedProvider.name} · ${selectedModel.name || selectedModel.id}`
                    : null) ||
                  (providerSettings.aiProvidersLoading
                    ? "Loading provider…"
                    : providerSettings.aiProvidersError
                      ? "Provider settings unavailable"
                      : providerSetupMessage)}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSwitchOpen((current) => !current)}
                disabled={providerSettings.aiProvidersLoading || availableProviders.length === 0}
                className="rounded-md px-2 py-1 text-[10px] font-mono text-terminal-dim transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-40"
                aria-expanded={switchOpen}
              >
                Switch model
              </button>
              <button
                type="button"
                onClick={clearConversation}
                disabled={running || messages.length === 0}
                className="rounded-md px-2 py-1 text-[10px] font-mono text-terminal-dim transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-terminal-dim transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text"
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
                  value={providerSettings.aiProviderId || ""}
                  onChange={(event) => {
                    providerSettings.setAiProviderId?.(event.target.value);
                    setProviderLabel(null);
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-terminal-border-subtle bg-terminal-bg px-2 py-1.5 text-[10px] font-mono text-terminal-text outline-none focus:border-terminal-green/50"
                >
                  {availableProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="AI model"
                  value={providerSettings.aiModelId || ""}
                  onChange={(event) => {
                    providerSettings.setAiModelId?.(event.target.value);
                    setProviderLabel(null);
                  }}
                  className="min-w-0 flex-[1.4] rounded-lg border border-terminal-border-subtle bg-terminal-bg px-2 py-1.5 text-[10px] font-mono text-terminal-text outline-none focus:border-terminal-green/50"
                >
                  {(selectedProvider?.models || []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-[9px] font-mono text-terminal-dimmer">
                Selection is remembered locally. Credentials stay in the local provider store.
              </div>
            </div>
          )}

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="pt-8 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-terminal-green-subtle text-xl text-terminal-green">
                  ✦
                </div>
                <div className="text-sm font-semibold text-terminal-text">
                  What would you like to find?
                </div>
                <div className="mx-auto mt-2 max-w-[280px] text-xs leading-relaxed text-terminal-dim">
                  I can search local sessions, explain usage data, read replay scenes, and open the
                  relevant view.
                </div>
                <div className="mt-5 space-y-2 text-left">
                  {[
                    "Find my most recent sessions",
                    "Why was my last session expensive?",
                    "Show sessions with compaction",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setInput(suggestion)}
                      className="block w-full rounded-lg border border-terminal-border-subtle bg-terminal-surface/50 px-3 py-2 text-left text-xs text-terminal-dim transition-colors hover:border-terminal-green/40 hover:text-terminal-text"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                          className="max-w-full truncate rounded-full border border-terminal-blue/25 bg-terminal-blue-subtle px-2 py-1 text-[10px] font-mono text-terminal-blue transition-colors hover:border-terminal-blue/50"
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
                          className="rounded-lg bg-terminal-green px-2.5 py-1.5 text-[10px] font-semibold text-terminal-bg transition-colors hover:bg-terminal-green/80"
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
            {!providerSettings.aiProvidersLoading && !providerReady && (
              <div className="mb-2 rounded-lg border border-terminal-orange/30 bg-terminal-orange-subtle px-3 py-2.5 text-[10px] font-mono leading-relaxed text-terminal-orange">
                <div>{providerSetupMessage}</div>
                <button
                  type="button"
                  onClick={() => navigateTo({ view: "dashboard", session: null, tab: "settings" })}
                  className="mt-1 font-semibold underline underline-offset-2 transition-colors hover:text-terminal-text"
                >
                  {providerSetupAction}
                </button>
              </div>
            )}
            <div className="flex items-end gap-2 rounded-xl border border-terminal-border-subtle bg-terminal-bg px-3 py-2 focus-within:border-terminal-green/50">
              <textarea
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
                    : hasConfiguredProvider
                      ? "Choose a provider and model first…"
                      : "Set up an AI provider first…"
                }
                className="max-h-28 min-h-10 flex-1 resize-none bg-transparent text-sm text-terminal-text outline-none placeholder:text-terminal-dimmer disabled:opacity-50"
              />
              {running ? (
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-lg bg-terminal-red-subtle px-2.5 py-1.5 text-[10px] font-semibold text-terminal-red"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() || !providerReady}
                  className="rounded-lg bg-terminal-green px-2.5 py-1.5 text-[10px] font-semibold text-terminal-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Ask
                </button>
              )}
            </div>
            {(remoteSession || context.mode === "dashboard") && (
              <label className="mt-2 flex items-start gap-2 rounded-lg border border-terminal-yellow/25 bg-terminal-yellow-subtle px-2.5 py-2 text-[9px] leading-relaxed font-mono text-terminal-yellow">
                <input
                  type="checkbox"
                  checked={allowRemoteData}
                  onChange={(event) => setAllowRemoteData(event.target.checked)}
                  className="mt-0.5 accent-terminal-yellow"
                />
                <span>
                  {remoteSession
                    ? "This replay came from SSH. Allow its session content to be sent to your configured AI provider for this chat."
                    : "Allow SSH session metadata and content to be sent to your configured AI provider for this chat."}
                </span>
              </label>
            )}
            <div className="mt-2 flex items-center justify-between text-[9px] font-mono text-terminal-dimmer">
              <span>
                Read-only ·{" "}
                {allowRemoteData
                  ? "SSH consent granted"
                  : remoteSession
                    ? "SSH consent required"
                    : "local sessions only"}
              </span>
              <button
                type="button"
                onClick={() => navigateTo({ view: "dashboard", session: null, tab: "settings" })}
                className="transition-colors hover:text-terminal-text"
              >
                Open provider settings
              </button>
            </div>
            <button
              type="button"
              aria-label="Resize Ask Replay"
              title="Drag to resize"
              onPointerDown={(event) => {
                event.preventDefault();
                resizeStartRef.current = {
                  x: event.clientX,
                  y: event.clientY,
                  width: panelSize.width,
                  height: panelSize.height,
                };
                setResizing(true);
              }}
              className="absolute right-1 bottom-1 h-5 w-5 cursor-nwse-resize rounded text-terminal-dimmer hover:text-terminal-text"
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
          className="flex items-center gap-2 rounded-full border border-terminal-green/35 bg-terminal-surface/90 px-3.5 py-2.5 text-xs font-semibold text-terminal-text shadow-layer-lg backdrop-blur-md transition-all hover:border-terminal-green/70 hover:text-terminal-green"
        >
          <span className="text-terminal-green">✦</span>
          Ask Replay
          <span className="rounded-full bg-terminal-green-subtle px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-terminal-green">
            Local
          </span>
        </button>
      )}
    </div>
  );
}
