import type { SessionSummary, SourceSession } from "../types";

// ─── Shared types ────────────────────────────────────────────────────

export type CachedListResponse<T> = {
  sessions: T[];
  cachedAt?: string;
};

export interface SourcesEnrichmentStatus {
  running: boolean;
  processed: number;
  total: number;
  updated: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

// ─── Cache helpers ───────────────────────────────────────────────────

export const CACHE_REFRESH_TTL_MS = 5 * 60 * 1000;

export function parseCachedList<T>(payload: unknown): CachedListResponse<T> | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as { sessions?: unknown; cachedAt?: unknown };
  if (!Array.isArray(obj.sessions)) return null;
  return {
    sessions: obj.sessions as T[],
    cachedAt: typeof obj.cachedAt === "string" ? obj.cachedAt : undefined,
  };
}

export function isCacheFresh(iso?: string, ttlMs = CACHE_REFRESH_TTL_MS): boolean {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs;
}

// ─── Formatting helpers ──────────────────────────────────────────────

export function formatCacheAge(iso?: string): string {
  if (!iso) return "just now";
  const ageMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatCompactAge(iso?: string, nowMs = Date.now()): string {
  if (!iso) return "";
  const ageMs = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "0m";
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatCost(cost?: number): string {
  if (!cost) return "";
  return `$${cost.toFixed(2)}`;
}

/** Shorten a full model ID to a human-friendly label, e.g. "claude-sonnet-4-20250514" → "Sonnet 4" */
export function shortModelName(model?: string): string {
  if (!model) return "";
  // claude-3-5-sonnet-20241022, claude-3-7-sonnet-20250219 (old naming)
  const legacy = model.match(/claude-(\d+)-(\d+)-(opus|sonnet|haiku)(?:-\d{8})?/i);
  if (legacy) {
    const family = legacy[3].charAt(0).toUpperCase() + legacy[3].slice(1).toLowerCase();
    return `${family} ${legacy[1]}.${legacy[2]}`;
  }
  // claude-sonnet-4-20250514, claude-opus-4-6, claude-opus-4-6-20250619 (new naming)
  const m = model.match(
    /claude-(?:(opus|sonnet|haiku)-)?((?:\d+)(?:[.-](?!\d{8})\d+)*)(?:-\d{8})?(?:-(opus|sonnet|haiku))?(?:$|\b)/i,
  );
  if (m) {
    const family = (m[1] || m[3] || "").toLowerCase();
    const ver = m[2].replace(/-/g, ".");
    const label = family.charAt(0).toUpperCase() + family.slice(1);
    return label ? `${label} ${ver}` : `Claude ${ver}`;
  }
  // Cursor models or other formats — return last meaningful segment
  const parts = model.split(/[-/]/);
  return parts.length > 1 ? parts.slice(0, 2).join("-") : model;
}

export function formatSize(bytes: number): string {
  const kb = Math.round(bytes / 1024);
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`;
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export function projectName(project: string): string {
  const special = specialProjectLabel(project);
  if (special) return special;
  const parts = project.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || project;
}

// ─── Text helpers ────────────────────────────────────────────────────

export const TITLE_MAX_CHARS = 120;

export function normalizeTitleText(value?: string): string {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
}

/** Detect system-generated user messages that aren't real human prompts */
function isSystemGeneratedMessage(text: string): boolean {
  return (
    text.startsWith("[Request interrupted by user") ||
    text.startsWith("<command-name>") ||
    text.startsWith("<command-message>") ||
    text.startsWith("<local-command-caveat>") ||
    text.startsWith("<local-command-stdout>") ||
    text.startsWith("<task-notification>") ||
    text.startsWith("<bash-input>") ||
    text.startsWith("<bash-stdout>")
  );
}

function stripTerminalTranscriptNoise(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^Last login:/i.test(trimmed)) return false;
    if (/^(?:➜|❯)\s+/.test(trimmed)) return false;
    if (/^github(?:\.com|\.rbx\.com)?$/i.test(trimmed)) return false;
    if (/^[✓✔]/.test(trimmed)) return false;
    if (/^-\s+(?:Active account|Git operations protocol|Token|Token scopes):/i.test(trimmed))
      return false;
    if (
      /^(?:credential|init|user|filter|alias|core|remote|branch)\.[^=]+=/i.test(trimmed) ||
      /^branch\.[^.]+\./i.test(trimmed)
    )
      return false;
    return true;
  });
  return kept.join("\n").trim();
}

function stripSlackPreamble(text: string): string {
  const lines = text.split("\n");
  const trimmed = [...lines];
  const removedSpeaker = /^\S.*\[\d{1,2}:\d{2}\s?(?:AM|PM)\]$/i.test(trimmed[0] || "");
  if (removedSpeaker) {
    trimmed.shift();
  }
  if (removedSpeaker && /^(?:hello|hi)\b/i.test((trimmed[0] || "").trim())) {
    trimmed.shift();
  }
  return trimmed.join("\n").trim();
}

function looksLikeConversationSummary(text: string): boolean {
  const normalized = text.trim();
  return (
    /^\[Previous conversation summary\]:/i.test(normalized) ||
    /^Summary:\s*1\.\s*Primary Request and Intent:/i.test(normalized)
  );
}

/** Strip system-injected noise from first prompt for display */
export function cleanPrompt(text: string): string {
  // Skip system-generated messages entirely
  if (isSystemGeneratedMessage(text)) return "";
  if (looksLikeConversationSummary(text)) return "";
  const hadTerminalNoise =
    /Last login:|Logged in to github\.com|Git operations protocol:|(?:➜|❯)\s+/i.test(text);
  let cleaned = stripSlackPreamble(stripTerminalTranscriptNoise(text));
  if (/<attached_files>|<code_selection\b/i.test(cleaned)) return "";
  cleaned = cleaned.replace(/<\/?[a-z][^>]*>/gi, "");
  cleaned = cleaned.replace(/^\s*\d+\|\s*/gm, "");
  cleaned = cleaned.replace(
    /Caveat:\s*The messages below were generated by the user while running local commands\.[^.]*/g,
    "",
  );
  cleaned = cleaned.replace(/DO NOT respond to these messages[^.]*/g, "");
  cleaned = cleaned.replace(/!\[AI Session:[^\]]*]\([^)]+\)/gi, "");
  cleaned = cleaned.replace(/###\s*AI Coding Session[^\n]*/gi, "");
  cleaned = cleaned.replace(/\d+\s+prompts?,\s+\d+\s+tools?,[^\n]*/gi, "");
  cleaned = cleaned.replace(/^\/\w+\s*/g, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned || looksLikeConversationSummary(cleaned)) return "";
  if (hadTerminalNoise && /^[a-z0-9._:-]{1,12}$/i.test(cleaned)) return "";
  return cleaned;
}

function sourcePromptTitle(
  s: Pick<SourceSession, "slug" | "title" | "prompts" | "firstPrompt">,
): string {
  const explicitTitle = s.title ? normalizeTitleText(cleanPrompt(s.title)) : "";
  if (explicitTitle) return explicitTitle;
  const promptCandidates = [...(s.prompts || []), s.firstPrompt];
  for (const candidate of promptCandidates) {
    const cleaned = normalizeTitleText(cleanPrompt(candidate || ""));
    if (cleaned) return cleaned;
  }
  return s.slug;
}

export function sourceSuggestedTitle(s: SourceSession): string {
  const promptTitle = sourcePromptTitle(s);
  if (s.replay?.title) {
    const replayTitle = normalizeTitleText(s.replay.title);
    if (replayTitle) return replayTitle;
  }
  return promptTitle;
}

export function sourceDisplayTitle(
  s: SourceSession,
  scanData?: {
    title?: string;
  } | null,
): string {
  const promptTitle = sourcePromptTitle(s);
  const replayTitle = normalizeTitleText(s.replay?.title);
  const scanTitle = normalizeTitleText(cleanPrompt(scanData?.title || ""));
  if (scanTitle) return scanTitle;
  if (promptTitle && promptTitle !== s.slug) return promptTitle;
  if (replayTitle) return replayTitle;
  return promptTitle;
}

export function replaySuggestedTitle(s: SessionSummary): string {
  const explicitTitle = normalizeTitleText(s.title);
  if (explicitTitle) return explicitTitle;
  const firstMessage = normalizeTitleText(s.firstMessage);
  if (firstMessage) return firstMessage;
  const firstFromMessages = normalizeTitleText(s.messages?.[0]);
  if (firstFromMessages) return firstFromMessages;
  return s.slug;
}

// ─── Navigation ──────────────────────────────────────────────────────

export function navigateTo(
  params: Record<string, string | null>,
  options: { replace?: boolean } = {},
) {
  const url = new URL(window.location.href);
  const DASHBOARD_PARAMS = ["tab", "project", "q", "archived"];

  // 1. If we are currently on dashboard, capture its state to sessionStorage
  const isCurrentlyDashboard =
    url.searchParams.get("view") === "dashboard" ||
    (!url.searchParams.has("session") &&
      !url.searchParams.has("gist") &&
      !url.searchParams.has("url"));
  if (isCurrentlyDashboard) {
    const dashboardState: Record<string, string> = {};
    DASHBOARD_PARAMS.forEach((p) => {
      const v = url.searchParams.get(p);
      if (v) dashboardState[p] = v;
    });
    if (Object.keys(dashboardState).length > 0) {
      sessionStorage.setItem("vibe_dashboard_state", JSON.stringify(dashboardState));
    } else {
      sessionStorage.removeItem("vibe_dashboard_state");
    }
  }

  // 2. If we are entering a session, remove dashboard params from URL
  if (params.session) {
    DASHBOARD_PARAMS.forEach((p) => {
      if (params[p] === undefined) {
        url.searchParams.delete(p);
      }
    });
    // Also remove 'view' if we are going to a session
    if (params.view === undefined) {
      url.searchParams.delete("view");
    }
  }

  // 3. If we are going back to dashboard, restored saved state if URL is empty
  const goingToDashboard = params.view === "dashboard" || (params.session === null && !params.view);
  if (goingToDashboard) {
    const saved = sessionStorage.getItem("vibe_dashboard_state");
    if (saved) {
      try {
        const state = JSON.parse(saved);
        Object.entries(state).forEach(([k, v]) => {
          if (params[k] === undefined && !url.searchParams.has(k)) {
            url.searchParams.set(k, v as string);
          }
        });
      } catch (e) {
        console.error("Failed to restore dashboard state", e);
      }
    }
    // Clean up viewer params when going back to dashboard
    url.searchParams.delete("v");
    url.searchParams.delete("s");
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  const changed = url.toString() !== window.location.href;
  if (options.replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
  // Only dispatch popstate for actual navigation (not filter typing).
  // replace + no view/session change = filter update, skip popstate to avoid re-mount.
  if (!options.replace && changed) {
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

// ─── Shared UI components ────────────────────────────────────────────

// ─── Shared UI helpers ────────────────────────────────────────────────

export const PROVIDER_BADGE_COLORS: Record<string, string> = {
  "claude-code": "bg-terminal-orange-subtle text-terminal-orange",
  cursor: "bg-terminal-blue-subtle text-terminal-blue",
};

export function providerBadgeLabel(provider: string): string {
  return provider === "claude-code" ? "Claude" : provider === "cursor" ? "Cursor" : provider;
}

export function providerBadgeClass(provider: string): string {
  return PROVIDER_BADGE_COLORS[provider] || "bg-terminal-surface text-terminal-dim";
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

/** Shorten a path to fit the sidebar, keeping first + last meaningful segments */
export function shortenPath(path: string): string {
  const special = specialProjectLabel(path);
  if (special) return special;
  const MAX = 26;
  if (path.length <= MAX) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  const first = parts[0];
  const lastTwo = parts.slice(-2).join("/");
  const candidate = `${first}/\u2026/${lastTwo}`;
  if (candidate.length <= MAX) return candidate;
  const last = parts[parts.length - 1];
  return `${first}/\u2026/${last}`;
}

export function computeProjectLabels(projects: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const p of projects) {
    labels.set(p, specialProjectLabel(p) || shortenPath(p));
  }
  return labels;
}

export function formatDataSourceLabel(hasSqlite?: boolean, dataSource?: string): string {
  if (dataSource === "sqlite") return hasSqlite ? "SQLite + JSONL supplement" : "SQLite";
  if (dataSource === "global-state") return "Cursor global state";
  if (dataSource === "jsonl") return hasSqlite ? "JSONL fallback" : "JSONL transcript";
  return hasSqlite ? "SQLite + JSONL" : "JSONL";
}

function specialProjectLabel(project: string): string | null {
  const normalized = project.replace(/\/$/, "");
  if (!normalized) return null;
  if (normalized === "(globalStorage)") return "Cursor Global Storage";
  if (normalized === "~") return "Home";
  if (/\/\.cursor\/projects\/.+\/terminals$/.test(normalized)) return "Cursor Terminals";
  if (/\/\.cursor\/extensions\//.test(normalized)) return "Cursor Extension";
  return null;
}
