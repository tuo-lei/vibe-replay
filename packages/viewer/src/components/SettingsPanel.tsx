import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { navigateTo, providerDisplayName } from "./dashboard-utils";
import { AiProviderSettings } from "./AiProviderSettings";
import { useAiProviderSettings } from "../hooks/useAiProviderSettings";

type RemoteProvider = "claude-code" | "codex" | "pi";

interface RemoteSource {
  id: string;
  sshHost: string;
  label: string;
  providers: RemoteProvider[];
  connectTimeoutMs: number;
}

interface RemoteSourceDraft {
  id: string;
  sshHost: string;
  label: string;
  providers: RemoteProvider[];
  connectTimeoutSeconds: string;
}

interface TestResult {
  ok: boolean;
  message: string;
}

const REMOTE_PROVIDERS: Array<{ value: RemoteProvider; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "pi", label: "Pi" },
];

const INPUT_CLASS =
  "w-full rounded-lg border border-terminal-border-subtle bg-terminal-bg px-3 py-2 text-xs font-mono text-terminal-text outline-none transition-colors placeholder:text-terminal-dimmer focus:border-terminal-green/60 focus:ring-1 focus:ring-terminal-green/30";

export type SettingsSectionId = "ai" | "remote" | "more";

const SETTINGS_SECTION_PARAM = "settingsSection";
const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  description: string;
}> = [
  { id: "ai", label: "AI", description: "Providers & authentication" },
  { id: "remote", label: "Remote SSH", description: "Hosts & source discovery" },
  { id: "more", label: "More", description: "Additional options" },
];

function settingsSectionElementId(section: SettingsSectionId): string {
  return `settings-${section}`;
}

export function getSettingsSectionFromUrl(): SettingsSectionId {
  if (typeof window === "undefined") return "ai";
  const value = new URLSearchParams(window.location.search).get(SETTINGS_SECTION_PARAM);
  return value === "remote" || value === "more" ? value : "ai";
}

function SettingsSectionIcon({ section }: { section: SettingsSectionId }) {
  const paths: Record<SettingsSectionId, string> = {
    ai: "M12 3v18M3 12h18M5 5l14 14M19 5 5 19",
    remote: "M4 6h16v12H4zM8 10h.01M11 10h.01M14 10h.01M7 15h10",
    more: "M5 7h14M5 12h14M5 17h14",
  };

  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[section]} />
    </svg>
  );
}

export function SettingsSectionNav({
  activeSection,
  onSelect,
}: {
  activeSection: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
}) {
  return (
    <aside className="shrink-0 border-b border-terminal-border-subtle bg-terminal-bg/70 md:w-56 md:border-b-0 md:border-r">
      <div className="flex gap-3 overflow-x-auto p-3 md:sticky md:top-0 md:flex-col md:gap-6 md:p-5">
        <div className="hidden md:block">
          <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-terminal-dimmer">
            Settings
          </div>
          <p className="mt-2 text-xs font-sans leading-relaxed text-terminal-dim">
            Configure local providers and session sources.
          </p>
        </div>

        <nav aria-label="Settings sections" className="flex min-w-max gap-1 md:min-w-0 md:flex-col">
          {SETTINGS_SECTIONS.map((section, index) => {
            const selected = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                aria-current={selected ? "location" : undefined}
                aria-controls={settingsSectionElementId(section.id)}
                onClick={() => onSelect(section.id)}
                className={`group flex min-w-[118px] items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors md:min-w-0 ${
                  selected
                    ? "bg-terminal-green-subtle text-terminal-green"
                    : "text-terminal-dim hover:bg-terminal-surface hover:text-terminal-text"
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                    selected
                      ? "bg-terminal-green/15"
                      : "bg-terminal-surface-2 text-terminal-dimmer group-hover:text-terminal-dim"
                  }`}
                >
                  <SettingsSectionIcon section={section.id} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-sans font-semibold">{section.label}</span>
                  <span className="hidden truncate text-[10px] font-mono text-terminal-dimmer md:block">
                    {section.description}
                  </span>
                </span>
                <span className="ml-auto hidden text-[10px] font-mono tabular-nums text-terminal-dimmer md:block">
                  0{index + 1}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="hidden border-t border-terminal-border-subtle pt-4 md:block">
          <div className="text-[10px] font-mono uppercase tracking-widest text-terminal-dimmer">
            Tip
          </div>
          <p className="mt-2 text-[11px] font-sans leading-relaxed text-terminal-dimmer">
            Use the menu or a settingsSection URL to jump between sections.
          </p>
        </div>
      </div>
    </aside>
  );
}

function emptyDraft(): RemoteSourceDraft {
  return {
    id: "",
    sshHost: "",
    label: "",
    providers: ["codex", "claude-code", "pi"],
    connectTimeoutSeconds: "10",
  };
}

function sourceToDraft(source: RemoteSource): RemoteSourceDraft {
  return {
    id: source.id,
    sshHost: source.sshHost,
    label: source.label,
    providers: [...source.providers],
    connectTimeoutSeconds: String(Math.round(source.connectTimeoutMs / 1_000)),
  };
}

function isRemoteProvider(value: unknown): value is RemoteProvider {
  return value === "claude-code" || value === "codex" || value === "pi";
}

function parseRemoteSources(value: unknown): RemoteSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<RemoteSource>;
    if (
      typeof source.id !== "string" ||
      typeof source.sshHost !== "string" ||
      typeof source.label !== "string" ||
      !Array.isArray(source.providers) ||
      typeof source.connectTimeoutMs !== "number"
    ) {
      return [];
    }
    return [
      {
        id: source.id,
        sshHost: source.sshHost,
        label: source.label,
        providers: source.providers.filter(isRemoteProvider),
        connectTimeoutMs: source.connectTimeoutMs,
      },
    ];
  });
}

function sourceForDraft(draft: RemoteSourceDraft): { source?: RemoteSource; error?: string } {
  const id = draft.id.trim();
  const sshHost = draft.sshHost.trim();
  const label = draft.label.trim() || id;
  const timeoutSeconds = Number(draft.connectTimeoutSeconds);

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id === "local") {
    return { error: "Use a unique id with letters, numbers, '.', '_' or '-'." };
  }
  if (!sshHost || sshHost.startsWith("-") || /\s/.test(sshHost)) {
    return { error: "SSH host must be a host alias or address without spaces." };
  }
  if (draft.providers.length === 0) {
    return { error: "Select at least one provider to scan on this host." };
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
    return { error: "Connection timeout must be between 1 and 60 seconds." };
  }

  return {
    source: {
      id,
      sshHost,
      label,
      providers: [...new Set(draft.providers)],
      connectTimeoutMs: timeoutSeconds * 1_000,
    },
  };
}

export default function SettingsPanel() {
  const aiProviderSettings = useAiProviderSettings(true);
  const [sources, setSources] = useState<RemoteSource[]>([]);
  const [draft, setDraft] = useState<RemoteSourceDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sourceRequestVersion = useRef(0);
  const sourceActionsLocked = loading || saving || refreshing;
  const contentRef = useRef<HTMLElement>(null);
  const initialSectionRef = useRef<SettingsSectionId>(getSettingsSectionFromUrl());
  const initialScrollDoneRef = useRef(false);
  const programmaticSectionRef = useRef<{ section: SettingsSectionId; until: number } | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSectionRef.current);

  const updateSectionUrl = useCallback((section: SettingsSectionId, replace: boolean) => {
    const current = new URLSearchParams(window.location.search).get(SETTINGS_SECTION_PARAM);
    if (current === section) return;
    navigateTo({ [SETTINGS_SECTION_PARAM]: section }, { replace, notify: false });
  }, []);

  const scrollToSection = useCallback((section: SettingsSectionId, behavior: ScrollBehavior) => {
    const target = document.getElementById(settingsSectionElementId(section));
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior, block: "start" });
    }
  }, []);

  const handleSectionSelect = useCallback(
    (section: SettingsSectionId) => {
      initialScrollDoneRef.current = true;
      programmaticSectionRef.current = { section, until: Date.now() + 1_000 };
      setActiveSection(section);
      updateSectionUrl(section, false);
      scrollToSection(section, "smooth");
    },
    [scrollToSection, updateSectionUrl],
  );

  const loadSettings = useCallback(async () => {
    const requestVersion = ++sourceRequestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as {
        remoteSources?: unknown;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(data?.error || "Settings could not be loaded");
      if (requestVersion === sourceRequestVersion.current) {
        setSources(parseRemoteSources(data?.remoteSources));
      }
    } catch (err) {
      if (requestVersion === sourceRequestVersion.current) {
        setError(err instanceof Error ? err.message : "Settings could not be loaded");
      }
    } finally {
      if (requestVersion === sourceRequestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Apply a deep link after both sections have had a chance to render. The
  // remote section moves when its settings load, so scrolling only on mount
  // would land at the wrong place for ?settingsSection=remote.
  useEffect(() => {
    if (initialScrollDoneRef.current || loading || aiProviderSettings.aiProvidersLoading) return;
    const timer = window.setTimeout(() => {
      if (initialScrollDoneRef.current) return;
      initialScrollDoneRef.current = true;
      programmaticSectionRef.current = {
        section: initialSectionRef.current,
        until: Date.now() + 1_000,
      };
      setActiveSection(initialSectionRef.current);
      scrollToSection(initialSectionRef.current, "auto");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [aiProviderSettings.aiProvidersLoading, loading, scrollToSection]);

  useEffect(() => {
    const handlePopState = () => {
      const section = getSettingsSectionFromUrl();
      programmaticSectionRef.current = { section, until: Date.now() + 1_000 };
      initialScrollDoneRef.current = true;
      setActiveSection(section);
      window.setTimeout(() => scrollToSection(section, "auto"), 0);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [scrollToSection]);

  // Keep the left navigation and the deep-link query parameter in sync while
  // the user scrolls, without adding a browser-history entry for every tick.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    const updateActiveSection = () => {
      if (!initialScrollDoneRef.current) return;
      const programmatic = programmaticSectionRef.current;
      if (programmatic) {
        if (Date.now() < programmatic.until) {
          setActiveSection((current) =>
            current === programmatic.section ? current : programmatic.section,
          );
          updateSectionUrl(programmatic.section, true);
          return;
        }
        programmaticSectionRef.current = null;
      }

      const rootRect = root.getBoundingClientRect();
      let next: SettingsSectionId = "ai";
      let lastVisible: SettingsSectionId | undefined;
      for (const section of SETTINGS_SECTIONS) {
        const element = document.getElementById(settingsSectionElementId(section.id));
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const top = rect.top - rootRect.top;
        if (top <= 144) next = section.id;
        if (top < root.clientHeight && rect.bottom > rootRect.top) lastVisible = section.id;
      }
      if (next === "ai" && lastVisible) next = lastVisible;
      setActiveSection((current) => (current === next ? current : next));
      updateSectionUrl(next, true);
    };

    const cancelProgrammaticScroll = () => {
      programmaticSectionRef.current = null;
    };

    updateActiveSection();
    root.addEventListener("scroll", updateActiveSection, { passive: true });
    root.addEventListener("wheel", cancelProgrammaticScroll, { passive: true });
    root.addEventListener("touchstart", cancelProgrammaticScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", updateActiveSection);
      root.removeEventListener("wheel", cancelProgrammaticScroll);
      root.removeEventListener("touchstart", cancelProgrammaticScroll);
    };
  }, [
    aiProviderSettings.aiProviders.length,
    aiProviderSettings.aiProvidersLoading,
    loading,
    sources.length,
    updateSectionUrl,
  ]);

  const saveSources = async (nextSources: RemoteSource[], successMessage: string) => {
    const requestVersion = ++sourceRequestVersion.current;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/remote-sources", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remoteSources: nextSources }),
      });
      const data = (await response.json().catch(() => null)) as {
        remoteSources?: unknown;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(data?.error || "SSH settings could not be saved");
      if (requestVersion === sourceRequestVersion.current) {
        setSources(parseRemoteSources(data?.remoteSources));
        setTestResults({});
        setMessage(successMessage);
        setDraft(null);
        setEditingId(null);
      }
    } catch (err) {
      if (requestVersion === sourceRequestVersion.current) {
        setError(err instanceof Error ? err.message : "SSH settings could not be saved");
      }
    } finally {
      if (requestVersion === sourceRequestVersion.current) setSaving(false);
    }
  };

  const submitDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    const parsed = sourceForDraft(draft);
    if (!parsed.source) {
      setError(parsed.error || "Invalid SSH source");
      return;
    }
    if (editingId === null && sources.some((source) => source.id === parsed.source!.id)) {
      setError(`An SSH source with id "${parsed.source.id}" already exists.`);
      return;
    }

    const nextSources =
      editingId === null
        ? [...sources, parsed.source]
        : sources.map((source) => (source.id === editingId ? parsed.source! : source));
    await saveSources(
      nextSources,
      `Saved "${parsed.source.label}". Source discovery will refresh.`,
    );
  };

  const removeSource = async (source: RemoteSource) => {
    if (!window.confirm(`Remove SSH source "${source.label}"?`)) return;
    await saveSources(
      sources.filter((candidate) => candidate.id !== source.id),
      `Removed "${source.label}".`,
    );
  };

  const testSource = async (source: RemoteSource) => {
    setTestingId(source.id);
    setError(null);
    try {
      const response = await fetch("/api/settings/remote-sources/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remoteSource: source }),
      });
      const result = (await response.json().catch(() => null)) as TestResult | null;
      setTestResults((current) => ({
        ...current,
        [source.id]: result || { ok: false, message: "SSH probe returned no response." },
      }));
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [source.id]: {
          ok: false,
          message: err instanceof Error ? err.message : "SSH probe failed.",
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const refreshSources = async () => {
    const requestVersion = ++sourceRequestVersion.current;
    setRefreshing(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/sources", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as {
        remoteSources?: unknown;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(data?.error || "Source discovery failed");
      if (requestVersion === sourceRequestVersion.current) {
        setMessage("Source discovery finished. Sessions and Insights will use the new catalog.");
        const refreshedSettings = parseRemoteSources(data?.remoteSources);
        setSources(refreshedSettings);
      }
    } catch (err) {
      if (requestVersion === sourceRequestVersion.current) {
        setError(err instanceof Error ? err.message : "Source discovery failed");
      }
    } finally {
      if (requestVersion === sourceRequestVersion.current) setRefreshing(false);
    }
  };

  const editingLabel = editingId === null ? "Add SSH source" : "Edit SSH source";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <SettingsSectionNav activeSection={activeSection} onSelect={handleSectionSelect} />
      <main ref={contentRef} className="min-w-0 flex-1 overflow-y-auto bg-terminal-bg">
        <div className="mx-auto w-full max-w-5xl space-y-5 p-5 md:p-8">
          <header>
            <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-terminal-green">
              Settings
            </div>
            <h1 className="mt-2 text-2xl font-sans font-bold text-terminal-text">
              Local workspace settings
            </h1>
            <p className="mt-1 max-w-2xl text-xs font-sans leading-relaxed text-terminal-dim">
              Configure the sources and defaults used by this dashboard. Settings stay on this
              machine and are stored outside the repository.
            </p>
          </header>

          {(error || message) && (
            <div
              className={`rounded-xl border px-4 py-3 text-xs font-mono ${
                error
                  ? "border-terminal-red/30 bg-terminal-red-subtle text-terminal-red"
                  : "border-terminal-green/30 bg-terminal-green-subtle text-terminal-green"
              }`}
              role={error ? "alert" : "status"}
            >
              {error || message}
            </div>
          )}

          <div id={settingsSectionElementId("ai")} className="scroll-mt-5">
            <AiProviderSettings actions={aiProviderSettings} variant="inline" />
          </div>

          <section
            id={settingsSectionElementId("remote")}
            className="rounded-xl bg-terminal-surface p-5 shadow-layer-sm md:p-6 scroll-mt-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-sans font-semibold text-terminal-text">
                  Remote SSH sources
                </h2>
                <p className="mt-1 max-w-2xl text-xs font-sans leading-relaxed text-terminal-dim">
                  Add a host alias or address from your normal OpenSSH configuration. vibe-replay
                  never stores passwords, private keys, or SSH commands here.
                </p>
              </div>
              <button
                type="button"
                disabled={sourceActionsLocked}
                onClick={() => {
                  setDraft(emptyDraft());
                  setEditingId(null);
                  setError(null);
                  setMessage(null);
                }}
                className="rounded-lg bg-terminal-blue-subtle px-3 py-2 text-xs font-mono font-semibold text-terminal-blue transition-colors hover:bg-terminal-blue/20"
              >
                + Add SSH source
              </button>
            </div>

            {loading ? (
              <div className="mt-5 rounded-lg bg-terminal-bg px-4 py-5 text-xs font-mono text-terminal-dimmer">
                Loading SSH settings…
              </div>
            ) : sources.length === 0 ? (
              <div className="mt-5 rounded-lg border border-dashed border-terminal-border-subtle bg-terminal-bg px-4 py-6 text-center text-xs font-mono text-terminal-dimmer">
                No remote SSH sources configured.
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {sources.map((source) => {
                  const result = testResults[source.id];
                  return (
                    <div
                      key={source.id}
                      className="rounded-lg border border-terminal-border-subtle bg-terminal-bg p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-sans font-semibold text-terminal-text">
                              {source.label}
                            </h3>
                            <span className="rounded bg-terminal-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-terminal-dimmer">
                              {source.id}
                            </span>
                          </div>
                          <div className="mt-1 break-all text-xs font-mono text-terminal-blue">
                            {source.sshHost}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {source.providers.map((provider) => (
                              <span
                                key={provider}
                                className="rounded-full bg-terminal-purple-subtle px-2 py-0.5 text-[10px] font-mono text-terminal-purple"
                              >
                                {providerDisplayName(provider)}
                              </span>
                            ))}
                            <span className="rounded-full bg-terminal-surface-2 px-2 py-0.5 text-[10px] font-mono text-terminal-dimmer">
                              {Math.round(source.connectTimeoutMs / 1_000)}s timeout
                            </span>
                          </div>
                          {result && (
                            <output
                              className={`mt-2 text-[10px] font-mono ${
                                result.ok ? "text-terminal-green" : "text-terminal-red"
                              }`}
                            >
                              {result.ok ? "✓ " : "✕ "}
                              {result.message}
                            </output>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void testSource(source)}
                            disabled={sourceActionsLocked || testingId === source.id}
                            className="rounded-md bg-terminal-green-subtle px-2.5 py-1.5 text-[10px] font-mono font-semibold text-terminal-green transition-colors hover:bg-terminal-green/20 disabled:cursor-wait disabled:opacity-50"
                          >
                            {testingId === source.id ? "Testing…" : "Test"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDraft(sourceToDraft(source));
                              setEditingId(source.id);
                              setError(null);
                              setMessage(null);
                            }}
                            disabled={sourceActionsLocked}
                            className="rounded-md bg-terminal-surface-2 px-2.5 py-1.5 text-[10px] font-mono text-terminal-dim transition-colors hover:text-terminal-text"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeSource(source)}
                            disabled={sourceActionsLocked}
                            className="rounded-md bg-terminal-red-subtle px-2.5 py-1.5 text-[10px] font-mono text-terminal-red transition-colors hover:bg-terminal-red/20"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {draft && (
              <form
                onSubmit={(event) => void submitDraft(event)}
                className="mt-5 space-y-4 rounded-lg border border-terminal-blue/30 bg-terminal-blue/5 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-sans font-semibold text-terminal-text">
                    {editingLabel}
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(null);
                      setEditingId(null);
                    }}
                    className="text-xs font-mono text-terminal-dimmer hover:text-terminal-text"
                  >
                    Cancel
                  </button>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <label htmlFor="remote-source-id" className="space-y-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-terminal-dimmer">
                      Stable id
                    </span>
                    <input
                      id="remote-source-id"
                      aria-label="Stable id"
                      className={INPUT_CLASS}
                      value={draft.id}
                      disabled={editingId !== null}
                      onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                      placeholder="remote-devspace"
                      autoComplete="off"
                    />
                    <span className="block text-[10px] font-sans text-terminal-dimmer">
                      Used to keep this source’s cached sessions separate.
                    </span>
                  </label>
                  <label htmlFor="remote-source-label" className="space-y-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-terminal-dimmer">
                      Display label
                    </span>
                    <input
                      id="remote-source-label"
                      aria-label="Display label"
                      className={INPUT_CLASS}
                      value={draft.label}
                      onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                      placeholder="ROS devspace"
                      autoComplete="off"
                    />
                  </label>
                  <label htmlFor="remote-source-host" className="space-y-1.5 md:col-span-2">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-terminal-dimmer">
                      SSH host
                    </span>
                    <input
                      id="remote-source-host"
                      aria-label="SSH host"
                      className={INPUT_CLASS}
                      value={draft.sshHost}
                      onChange={(event) => setDraft({ ...draft, sshHost: event.target.value })}
                      placeholder="dev.example.internal"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span className="block text-[10px] font-sans text-terminal-dimmer">
                      This is passed as the OpenSSH host argument. Configure aliases, keys, and
                      ProxyJump in your normal SSH config.
                    </span>
                  </label>
                </div>

                <fieldset>
                  <legend className="text-[10px] font-mono uppercase tracking-widest text-terminal-dimmer">
                    Providers to scan
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {REMOTE_PROVIDERS.map((provider) => {
                      const checked = draft.providers.includes(provider.value);
                      return (
                        <label
                          key={provider.value}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs font-mono transition-colors ${
                            checked
                              ? "border-terminal-green/40 bg-terminal-green-subtle text-terminal-green"
                              : "border-terminal-border-subtle bg-terminal-bg text-terminal-dim"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setDraft({
                                ...draft,
                                providers: checked
                                  ? draft.providers.filter((value) => value !== provider.value)
                                  : [...draft.providers, provider.value],
                              })
                            }
                            className="accent-terminal-green"
                          />
                          {provider.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="flex flex-wrap items-end justify-between gap-4">
                  <label htmlFor="remote-source-timeout" className="w-40 space-y-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-terminal-dimmer">
                      Connect timeout (seconds)
                    </span>
                    <input
                      id="remote-source-timeout"
                      aria-label="Connect timeout (seconds)"
                      type="number"
                      min={1}
                      max={60}
                      step={1}
                      className={INPUT_CLASS}
                      value={draft.connectTimeoutSeconds}
                      onChange={(event) =>
                        setDraft({ ...draft, connectTimeoutSeconds: event.target.value })
                      }
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-lg bg-terminal-blue px-4 py-2 text-xs font-mono font-semibold text-terminal-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save SSH source"}
                  </button>
                </div>
              </form>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-terminal-border-subtle pt-4">
              <p className="max-w-2xl text-[10px] font-sans leading-relaxed text-terminal-dimmer">
                Saving starts a background scan. Use this button when you want to refresh the source
                catalog immediately.
              </p>
              <button
                type="button"
                onClick={() => void refreshSources()}
                disabled={sourceActionsLocked}
                className="rounded-lg bg-terminal-surface-2 px-3 py-2 text-xs font-mono text-terminal-dim transition-colors hover:text-terminal-text disabled:cursor-wait disabled:opacity-50"
              >
                {refreshing ? "Refreshing…" : "Refresh sources now"}
              </button>
            </div>
          </section>

          <section
            id={settingsSectionElementId("more")}
            className="rounded-xl border border-dashed border-terminal-border-subtle bg-terminal-surface/50 p-5 md:p-6 scroll-mt-5"
          >
            <h2 className="text-sm font-sans font-semibold text-terminal-text">More settings</h2>
            <p className="mt-1 text-xs font-sans leading-relaxed text-terminal-dim">
              Additional common options can be added here without changing provider session data or
              replay files.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
