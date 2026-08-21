import type { SessionSummary, SourceSession } from "../types";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "../utils/safe-storage";

// ─── Shared types ────────────────────────────────────────────────────

export type CachedListResponse<T> = {
  sessions: T[];
  cachedAt?: string;
  discoveredAt?: string;
  stale?: boolean;
  staleProviders?: string[];
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
  const obj = payload as {
    sessions?: unknown;
    cachedAt?: unknown;
    discoveredAt?: unknown;
    stale?: unknown;
    staleProviders?: unknown;
  };
  if (!Array.isArray(obj.sessions)) return null;
  return {
    sessions: obj.sessions as T[],
    cachedAt: typeof obj.cachedAt === "string" ? obj.cachedAt : undefined,
    discoveredAt: typeof obj.discoveredAt === "string" ? obj.discoveredAt : undefined,
    stale: typeof obj.stale === "boolean" ? obj.stale : undefined,
    staleProviders: Array.isArray(obj.staleProviders)
      ? obj.staleProviders.filter((provider): provider is string => typeof provider === "string")
      : undefined,
  };
}

export function isCacheFresh(iso?: string, ttlMs = CACHE_REFRESH_TTL_MS): boolean {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs;
}

export function shouldRefreshCachedList<T>(
  cached: CachedListResponse<T> | null | undefined,
  ttlMs = CACHE_REFRESH_TTL_MS,
): boolean {
  // `stale` is the authoritative server-computed signal; `staleProviders` is diagnostic.
  if (cached?.stale === true) return true;
  return !isCacheFresh(cached?.discoveredAt || cached?.cachedAt, ttlMs);
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

export function formatCompactDuration(ms: number): string {
  if (ms === 0) return "0m";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function formatSize(bytes: number): string {
  const kb = Math.round(bytes / 1024);
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`;
}

/** Compact token count, e.g. 999251 → "999K", 1_200_000 → "1.2M". */
export function formatTokens(n?: number): string {
  if (!n) return "0";
  // Round-trip guard: 999_500..999_999 would render as "1000K" via Math.round.
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
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
    /^Summary:\s*1\.\s*Primary Request and Intent:/i.test(normalized) ||
    // Mirror the CLI cleanup so cached Cursor previews hide the same
    // truncated summary fragment instead of surfacing it as a title/prompt.
    /^and merge infrastructure was built for human-paced output/i.test(normalized)
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

export function sessionPromptPreview(
  session: Pick<SourceSession, "prompts" | "firstPrompt">,
  scanData?: { firstPrompt?: string } | null,
  displayTitle?: string,
): string[] {
  const prompts: string[] = [];
  const seen = new Set<string>();
  const candidates = [scanData?.firstPrompt, ...(session.prompts || [])];
  if (!scanData?.firstPrompt) candidates.push(session.firstPrompt);
  for (const candidate of candidates) {
    const cleaned = cleanPrompt(candidate || "");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    prompts.push(cleaned);
  }
  const normalizedTitle = cleanPrompt(displayTitle || "");
  if (prompts.length > 1 && normalizedTitle && prompts[0] === normalizedTitle) {
    prompts.shift();
  }
  if (prompts.length > 1 && /^(?:and|but|or|so|then)\b/i.test(prompts[0] || "")) {
    prompts.shift();
  }
  return prompts;
}

export function nonDefaultBranch(branch?: string): string | undefined {
  return branch && branch !== "main" && branch !== "master" ? branch : undefined;
}

export function shortCoworkSpaceId(spaceId: string): string {
  const compact = spaceId.replace(/^space[_-]?/, "");
  return compact.slice(0, 6) || spaceId.slice(0, 6);
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
  options: { replace?: boolean; notify?: boolean } = {},
) {
  const url = new URL(window.location.href);

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
      safeStorageSet(sessionStorage, "vibe_dashboard_state", JSON.stringify(dashboardState));
    } else {
      safeStorageRemove(sessionStorage, "vibe_dashboard_state");
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
    const saved = safeStorageGet(sessionStorage, "vibe_dashboard_state");
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
  // Only dispatch popstate for route-level navigation. Dashboard filter controls
  // update their own local state and can opt out to avoid flashing the global
  // session loader between two filtered list states.
  if (!options.replace && changed && options.notify !== false) {
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export const DASHBOARD_PARAMS = [
  "tab",
  "project",
  "q",
  "archived",
  "provider",
  "repo",
  "tool",
  "mcp",
  "mcpTool",
  "skill",
  "agentRuns",
  "replay",
] as const;

/**
 * Navigate to live mode for a running source session.
 *
 * Live mode is a separate viewer state, not a dashboard tab — so we strip
 * every dashboard- and viewer-scoped query param before applying the live
 * triplet. Otherwise leftovers like `view=dashboard` or `tab=sessions` (which
 * useSessionLoader prioritizes) would block the SSE stream from opening.
 */
export function navigateToLive(provider: string, sessionId: string) {
  const url = new URL(window.location.href);
  for (const k of [...DASHBOARD_PARAMS, "view", "session", "gist", "cloud", "url", "v", "s"]) {
    url.searchParams.delete(k);
  }
  url.searchParams.set("live", "1");
  url.searchParams.set("provider", provider);
  url.searchParams.set("sessionId", sessionId);
  window.history.pushState({}, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ─── Shared UI components ────────────────────────────────────────────

// ─── Shared UI helpers ────────────────────────────────────────────────

// The three Claude sources stay in the same warm color family but each gets a
// distinct hue so they're tellable apart at icon size: Code = orange (the
// signature tint), Cowork = sienna (redder), Desktop = yellow (brighter).
export const PROVIDER_BADGE_COLORS: Record<string, string> = {
  "claude-code": "bg-terminal-orange-subtle text-terminal-orange",
  "claude-desktop": "bg-terminal-yellow-subtle text-terminal-yellow",
  "claude-cowork": "bg-terminal-sienna-subtle text-terminal-sienna",
  codex: "bg-terminal-purple-subtle text-terminal-purple",
  cursor: "bg-terminal-blue-subtle text-terminal-blue",
  opencode: "bg-terminal-green-subtle text-terminal-green",
  hermes: "bg-terminal-red-subtle text-terminal-red",
  pi: "bg-terminal-cyan-subtle text-terminal-cyan",
};

const PROVIDER_BADGE_LABELS: Record<string, string> = {
  "claude-code": "Claude",
  "claude-desktop": "Desktop",
  "claude-cowork": "Cowork",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  hermes: "Hermes",
  pi: "Pi",
};

// Full names for contexts where the short pill label is too terse — insights
// page header, provider breakdown rows, landing hero byline.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  "claude-cowork": "Claude Cowork",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  hermes: "Hermes",
  pi: "Pi",
};

// Solid (non-subtle) bar colors used by the provider breakdown bar chart.
// Mirror the badge hues so the Claude sub-kinds stay distinguishable here too.
const PROVIDER_BAR_COLORS: Record<string, string> = {
  "claude-code": "bg-terminal-orange",
  "claude-desktop": "bg-terminal-yellow",
  "claude-cowork": "bg-terminal-sienna",
  codex: "bg-terminal-purple",
  cursor: "bg-terminal-blue",
  opencode: "bg-terminal-green",
  hermes: "bg-terminal-red",
  pi: "bg-terminal-cyan",
};

// Provider "color family" for home-page chip UI that composes several tint
// variants together (bg/8, text/80, text, dot). Returning the token name keeps
// Tailwind's static-class extraction happy and avoids template-string bugs.
const PROVIDER_FAMILY: Record<
  string,
  "orange" | "sienna" | "yellow" | "blue" | "purple" | "cyan" | "green" | "red" | "dim"
> = {
  "claude-code": "orange",
  "claude-desktop": "yellow",
  "claude-cowork": "sienna",
  codex: "purple",
  cursor: "blue",
  opencode: "green",
  hermes: "red",
  pi: "cyan",
};

export function providerFamily(
  provider: string,
): "orange" | "sienna" | "yellow" | "blue" | "purple" | "cyan" | "green" | "red" | "dim" {
  return PROVIDER_FAMILY[provider] || "dim";
}

export function providerBadgeLabel(provider: string): string {
  return PROVIDER_BADGE_LABELS[provider] || provider;
}

export function providerBadgeClass(provider: string): string {
  return PROVIDER_BADGE_COLORS[provider] || "bg-terminal-surface text-terminal-dim";
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] || provider;
}

export function providerBarClass(provider: string): string {
  return PROVIDER_BAR_COLORS[provider] || "bg-terminal-dim";
}

export function dataSourceBadgeClass(
  dataSource?: string,
  hasSqlite?: boolean,
  hasSdk?: boolean,
): string {
  // SDK gets its own distinct purple badge so users can spot Cursor SDK sessions
  // at a glance (they're functionally different from IDE chats — different store,
  // different agent runtime, different lifecycle).
  if (hasSdk) return "bg-terminal-purple-subtle text-terminal-purple";
  if (dataSource === "jsonl" || dataSource === "jsonl+tools") {
    return "bg-terminal-orange-subtle text-terminal-orange";
  }
  if (dataSource === "global-state") return "bg-terminal-blue-subtle text-terminal-blue";
  if (dataSource === "sqlite" || hasSqlite) return "bg-terminal-green-subtle text-terminal-green";
  return "bg-terminal-surface-2 text-terminal-dimmer";
}

// ─── Archive helpers ────────────────────────────────────────────────

/** Optimistic archive toggle with rollback on failure. */
export async function toggleArchiveSlug(
  slug: string,
  archivedSlugs: Set<string>,
  setArchivedSlugs: React.Dispatch<React.SetStateAction<Set<string>>>,
): Promise<void> {
  const isArchived = archivedSlugs.has(slug);
  setArchivedSlugs((prev) => {
    const next = new Set(prev);
    if (isArchived) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    return next;
  });
  try {
    const resp = await fetch(`/api/archive/${slug}`, { method: isArchived ? "DELETE" : "POST" });
    if (!resp.ok) throw new Error("Archive toggle failed");
  } catch (err) {
    console.error("Archive toggle failed:", getErrorMessage(err));
    setArchivedSlugs((prev) => {
      const next = new Set(prev);
      if (isArchived) {
        next.add(slug);
      } else {
        next.delete(slug);
      }
      return next;
    });
  }
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

/**
 * True when `fetch()` rejected at the network/transport layer (the request never
 * got an HTTP response) rather than the server returning an error status.
 *
 * The dashboard talks to a *local* CLI server. In dev that server restarts on
 * source changes (and on Windows the tsx cold-boot widens the restart window to
 * a couple of seconds), so an in-flight request can land while the port is
 * momentarily closed. The browser surfaces that as `TypeError: Failed to fetch`
 * — which is meaningless to a user and looks like a hard failure even though the
 * server comes right back. We use this to retry instead of erroring.
 */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // A failed fetch rejects with a TypeError (undici also uses TypeError), but the
  // message differs across engines: "Failed to fetch" (Chromium), "NetworkError
  // when attempting to fetch resource" (Firefox), "Load failed" (Safari), or
  // "fetch failed" (undici). Match the message rather than the bare type so we
  // don't classify unrelated TypeErrors (real programming bugs) as retryable.
  return /failed to fetch|networkerror|load failed|fetch failed/i.test(err.message);
}

/** A user-facing message that explains a dropped local-server connection. */
export function getFriendlyErrorMessage(err: unknown): string {
  if (isNetworkError(err)) {
    return "Couldn't reach the local vibe-replay server — it may be starting up or restarting. Try again in a moment.";
  }
  return getErrorMessage(err);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` wrapper that retries transient failures against the local CLI server.
 *
 * Retries on (a) network-level rejections (server restarting / not yet listening)
 * and (b) gateway statuses the Vite dev proxy returns while the upstream is down
 * (502/503/504). Real application errors (4xx, 500 with a JSON body) are returned
 * to the caller unchanged so existing error handling still works.
 *
 * Only retries when the connection itself failed (no HTTP response), so a request
 * that reached the server is never silently re-sent. It is therefore safe for GETs
 * and for *idempotent* mutations whose effect is keyed and overwritten in place
 * (e.g. generate/regenerate, keyed by session slug). Do not use it for mutations
 * that accumulate or are otherwise unsafe to repeat.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { retries?: number; baseDelayMs?: number },
): Promise<Response> {
  const retries = opts?.retries ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 250;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(input, init);
      if (
        (resp.status === 502 || resp.status === 503 || resp.status === 504) &&
        attempt < retries
      ) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (!isNetworkError(err) || attempt === retries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  // Unreachable when retries >= 0 (the final iteration always returns or throws),
  // but required to satisfy control-flow analysis and to handle a retries < 0 call.
  throw lastErr ?? new Error("fetchWithRetry: no attempts were made");
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

export function formatDataSourceLabel(
  hasSqlite?: boolean,
  dataSource?: string,
  hasSdk?: boolean,
): string {
  // Cursor SDK gets a dedicated label whenever the SDK store is present, since
  // its agent stream is the source of structured tool results — independent of
  // whether an IDE chat store.db also exists for the same workspace.
  if (hasSdk) {
    if (dataSource === "jsonl+tools") return "Cursor SDK + JSONL + agent-tools";
    if (dataSource === "jsonl") return "Cursor SDK + JSONL";
    return "Cursor SDK";
  }
  if (dataSource === "sqlite") return hasSqlite ? "SQLite + JSONL supplement" : "SQLite";
  if (dataSource === "global-state") return "Cursor global state";
  if (dataSource === "jsonl") return hasSqlite ? "JSONL fallback" : "JSONL transcript";
  if (dataSource === "jsonl+tools")
    return hasSqlite ? "JSONL + agent-tools fallback" : "JSONL + agent-tools";
  return hasSqlite ? "SQLite + JSONL" : "JSONL";
}

/**
 * Claude Code's agent isolation creates worktrees under
 * `<project>/.claude/worktrees/<docker-style-name>/`. These are auto-generated
 * sandboxes the user has no awareness of and may be cleaned up at any time, so
 * we roll their sessions up under the parent project for display.
 */
const AGENT_WORKTREE_RE = /^(.+?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/;

export function agentWorktreeParent(project: string): string | null {
  const m = project.replace(/\/$/, "").match(AGENT_WORKTREE_RE);
  return m ? m[1] : null;
}

/**
 * A run id at the end of a directory name: a UUID, or the hex digest that
 * tools use to keep concurrent runs from colliding. Twelve characters is the
 * shortest digest worth trusting — below that, ordinary names (`ros-4`, a
 * date, a PR number) start matching. All-numeric suffixes are excluded because
 * timestamp-like project names are common and are not run identifiers.
 */
const RUN_ID_SUFFIX_RE =
  /(?:^|-)(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]{12,}$)[0-9]*[a-f][0-9a-f]*)$/i;

/**
 * Scratch workspaces created one per automated run — SDK agents, PR-review
 * worktrees, temp dirs. Each run gets its own directory, so left alone they
 * outnumber real projects several times over while telling the reader nothing:
 * the run id is the only thing separating them. They roll up under the
 * directory that holds them, which is the level a human would recognize.
 */
export function agentRunWorkspaceParent(project: string): string | null {
  const clean = project.replace(/[\\/]+$/, "");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (slash <= 0) return null;
  if (!RUN_ID_SUFFIX_RE.test(clean.slice(slash + 1))) return null;
  const parent = clean.slice(0, slash);
  return /^[A-Za-z]:$/.test(parent) ? null : parent;
}

export function isAgentRunWorkspace(project: string): boolean {
  return agentRunWorkspaceParent(project) !== null;
}

export function rollupProject(project: string): string {
  return agentWorktreeParent(project) ?? agentRunWorkspaceParent(project) ?? project;
}

export interface TopProjectEntry {
  project: string;
  sessions: number;
  cost: number;
  prompts: number;
  durationMs: number;
  toolCalls: number;
  edits: number;
  branchCount: number;
  prCount: number;
  memoryFileCount: number;
  lastActivity: string;
  sessionsPerDay: Record<string, number>;
}

/**
 * Roll up Claude agent worktree entries under their parent project. Sums
 * additive metrics (`branchCount`/`prCount` may double-count when a worktree
 * shares the parent's branch — accepted as an inherent approximation since
 * the scanner counts per-path), takes the max of `lastActivity` and
 * `memoryFileCount` (parent typically owns the memory files), and merges
 * `sessionsPerDay` by day key. The resulting entry's `project` is the
 * parent path, except when callers explicitly preserve agent-run workspaces
 * for the Projects toggle.
 */
export function rollupTopProjects(
  projects: readonly TopProjectEntry[],
  options: { rollupAgentRuns?: boolean } = {},
): TopProjectEntry[] {
  const byParent = new Map<string, TopProjectEntry>();
  const rollupAgentRuns = options.rollupAgentRuns !== false;

  for (const p of projects) {
    const key =
      agentWorktreeParent(p.project) ??
      (rollupAgentRuns ? agentRunWorkspaceParent(p.project) : null) ??
      p.project;
    const existing = byParent.get(key);
    if (existing) {
      existing.sessions += p.sessions;
      existing.cost += p.cost;
      existing.prompts += p.prompts;
      existing.durationMs += p.durationMs;
      existing.toolCalls += p.toolCalls;
      existing.edits += p.edits;
      existing.branchCount += p.branchCount;
      existing.prCount += p.prCount;
      existing.memoryFileCount = Math.max(existing.memoryFileCount, p.memoryFileCount);
      if ((p.lastActivity || "") > (existing.lastActivity || "")) {
        existing.lastActivity = p.lastActivity;
      }
      for (const [day, count] of Object.entries(p.sessionsPerDay)) {
        existing.sessionsPerDay[day] = (existing.sessionsPerDay[day] || 0) + count;
      }
    } else {
      byParent.set(key, {
        ...p,
        project: key,
        sessionsPerDay: { ...p.sessionsPerDay },
      });
    }
  }

  return [...byParent.values()];
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
