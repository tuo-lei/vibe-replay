import {
  agentRunWorkspaceParent as sharedAgentRunWorkspaceParent,
  agentWorktreeParent as sharedAgentWorktreeParent,
  cursorSdkWorkflowLabel,
  isAutomatedProject,
  mergeProjectIdentities,
  projectIdentityKey,
  sessionLocationHash,
} from "@vibe-replay/types";
import type { ProjectIdentity, SessionLocation, SessionTranscriptStatus } from "@vibe-replay/types";
import type { SessionSummary, SourceSession } from "../types";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "../utils/safe-storage";

// ─── Shared types ────────────────────────────────────────────────────

export type CachedListResponse<T> = {
  sessions: T[];
  cachedAt?: string;
  discoveredAt?: string;
  stale?: boolean;
  staleProviders?: string[];
  failedProviders?: string[];
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

export function sessionIdentityKey(
  session: Pick<SessionSummary, "provider" | "sessionId" | "slug" | "location"> & {
    sourceSlug?: string;
  },
): string {
  const locationKey = session.location?.kind === "ssh" ? `ssh:${session.location.id}` : "local";
  return `${locationKey}\0${session.provider}\0${session.sessionId || session.sourceSlug || session.slug}`;
}

export function transcriptStatusLabel(status?: SessionTranscriptStatus): string | undefined {
  if (status === "no-prompts") return "no replayable prompts";
  if (status === "unreadable") return "unreadable transcript";
  return undefined;
}

export function remoteSourceFailureLabels(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const payload = value as {
    failedProviders?: unknown;
    remoteSources?: unknown;
  };
  const failures = payload.failedProviders;
  if (!Array.isArray(failures)) return [];
  const labels = new Map<string, string>();
  if (Array.isArray(payload.remoteSources)) {
    for (const source of payload.remoteSources) {
      if (!source || typeof source !== "object") continue;
      const record = source as { id?: unknown; label?: unknown };
      if (
        typeof record.id === "string" &&
        typeof record.label === "string" &&
        record.label.trim()
      ) {
        labels.set(record.id, record.label.trim());
      }
    }
  }
  return failures
    .filter(
      (failure): failure is string => typeof failure === "string" && failure.startsWith("ssh:"),
    )
    .map((failure) => {
      const id = failure.slice("ssh:".length);
      return labels.get(id) || id;
    });
}

export function transcriptStatusDescription(status?: SessionTranscriptStatus): string | undefined {
  if (status === "no-prompts") {
    return "The source is readable, but it does not contain a meaningful human prompt to replay.";
  }
  if (status === "unreadable") {
    return "The source transcript is unavailable, damaged, or could not be read reliably.";
  }
  return undefined;
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
    failedProviders?: unknown;
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
    failedProviders: Array.isArray(obj.failedProviders)
      ? obj.failedProviders.filter((provider): provider is string => typeof provider === "string")
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

export function formatGenerationElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  return formatCompactDuration(ms);
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

export function normalizeMcpServerName(server: string): string {
  const normalized = server.trim();
  return normalized === "" || normalized === "-" ? "Unknown" : normalized;
}

export function normalizeMcpToolName(tool: string): string {
  if (tool === "-") return "Unknown";
  if (tool.startsWith("-/")) return `Unknown${tool.slice(1)}`;
  return tool;
}

// ─── Text helpers ────────────────────────────────────────────────────

export const TITLE_MAX_CHARS = 120;

export function normalizeTitleText(value?: string): string {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
}

const CURSOR_PLACEHOLDER_TITLES = new Set(["new agent", "new chat", "untitled"]);

function sessionTitleValue(provider: string, value?: string): string {
  const normalized = normalizeTitleText(cleanPrompt(value || ""));
  if (provider === "cursor" && CURSOR_PLACEHOLDER_TITLES.has(normalized.toLowerCase())) {
    return "";
  }
  return normalized;
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
  s: Pick<SourceSession, "provider" | "slug" | "title" | "prompts" | "firstPrompt">,
): string {
  const explicitTitle = sessionTitleValue(s.provider, s.title);
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
    const replayTitle = sessionTitleValue(s.provider, s.replay.title);
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
  const sourceTitle = sessionTitleValue(s.provider, s.title);
  const promptTitle = sourcePromptTitle(s);
  const replayTitle = normalizeTitleText(s.replay?.title);
  const scanTitle = sessionTitleValue(s.provider, scanData?.title);
  if (sourceTitle) return sourceTitle;
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

export type NavigationValue = string | readonly string[] | null;

function isDashboardUrl(url: URL): boolean {
  return (
    url.searchParams.get("view") === "dashboard" ||
    (!url.searchParams.has("session") &&
      !url.searchParams.has("gist") &&
      !url.searchParams.has("url"))
  );
}

/** Persist navigable dashboard state before leaving it for a resource URL. */
export function persistDashboardState(url = new URL(window.location.href)): void {
  if (!isDashboardUrl(url)) return;
  const dashboardState: Record<string, string | string[]> = {};
  DASHBOARD_PARAMS.forEach((p) => {
    if (DASHBOARD_TRANSIENT_PARAMS.has(p)) return;
    const values = url.searchParams.getAll(p);
    if (values.length === 1) dashboardState[p] = values[0]!;
    else if (values.length > 1) dashboardState[p] = values;
  });
  if (Object.keys(dashboardState).length > 0) {
    safeStorageSet(sessionStorage, "vibe_dashboard_state", JSON.stringify(dashboardState));
  } else {
    safeStorageRemove(sessionStorage, "vibe_dashboard_state");
  }
}

/** Navigate to a same-origin permalink while preserving dashboard return state. */
export function navigateToPermalink(permalink: string): boolean {
  try {
    const current = new URL(window.location.href);
    const target = new URL(permalink, current.href);
    if (target.origin !== current.origin) return false;
    if (target.searchParams.has("session")) persistDashboardState(current);
    window.history.pushState({}, "", target.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return true;
  } catch {
    return false;
  }
}

export function navigateTo(
  params: Record<string, NavigationValue>,
  options: { replace?: boolean; notify?: boolean } = {},
) {
  const url = new URL(window.location.href);

  // 1. If we are currently on dashboard, capture its state to sessionStorage
  persistDashboardState(url);

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
    if (params.drawer === undefined) {
      url.searchParams.delete("drawer");
    }
  }

  // 3. If we are going back to dashboard, restored saved state if URL is empty
  const goingToDashboard = params.view === "dashboard" || (params.session === null && !params.view);
  if (goingToDashboard) {
    // Remove the session viewer's target before restoring the dashboard state;
    // a project-scoped dashboard state may put its target back below.
    url.searchParams.delete("targetId");
    const saved = safeStorageGet(sessionStorage, "vibe_dashboard_state");
    if (saved) {
      try {
        const state = JSON.parse(saved);
        Object.entries(state).forEach(([k, v]) => {
          if (params[k] === undefined && !url.searchParams.has(k)) {
            if (Array.isArray(v)) {
              for (const value of v) {
                if (typeof value === "string") url.searchParams.append(k, value);
              }
            } else if (typeof v === "string") {
              url.searchParams.set(k, v);
            }
          }
        });
      } catch (e) {
        console.error("Failed to restore dashboard state", e);
      }
    }
    // Clean up viewer params when going back to dashboard
    url.searchParams.delete("v");
    url.searchParams.delete("s");
    url.searchParams.delete("drawer");
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key);
    else if (Array.isArray(value)) {
      url.searchParams.delete(key);
      for (const item of value) url.searchParams.append(key, item);
    } else if (typeof value === "string") {
      url.searchParams.set(key, value);
    }
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
  "settingsSection",
  "selected",
  "selectedProvider",
  "selectedSessionId",
  "selectedTargetId",
  "project",
  "projectView",
  "insightsSection",
  "targetId",
  "q",
  "archived",
  "provider",
  "repo",
  "tool",
  "mcp",
  "mcpTool",
  "skill",
  "compacted",
  "agentRuns",
  "insightsRange",
  "replay",
] as const;

/**
 * Selection links are stable permalinks while visible, but must not be
 * restored after leaving the dashboard via sessionStorage. Otherwise a
 * harmless dashboard navigation could reopen an old source-session modal.
 */
const DASHBOARD_TRANSIENT_PARAMS = new Set([
  "selected",
  "selectedProvider",
  "selectedSessionId",
  "selectedTargetId",
]);

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

/** Compare locations by stable target identity; omitted/local locations are equivalent. */
export function sameSessionLocation(left?: SessionLocation, right?: SessionLocation): boolean {
  const leftTargetId = left?.kind === "ssh" ? left.id : undefined;
  const rightTargetId = right?.kind === "ssh" ? right.id : undefined;
  return leftTargetId === rightTargetId;
}

/** Keep archive markers distinct when local and SSH sessions share a slug. */
export function archiveSessionKey(slug: string, location?: SessionLocation): string {
  return location?.kind === "ssh" ? `${slug}--ssh-${sessionLocationHash(location.id)}` : slug;
}

/** Prefer a replay's provider slug when its output directory is location-scoped. */
export function replayArchiveKey(
  replay: Pick<SessionSummary, "slug" | "sourceSlug" | "location">,
): string {
  return archiveSessionKey(replay.sourceSlug || replay.slug, replay.location);
}

/** Optimistic archive toggle with rollback on failure. */
export async function toggleArchiveSlug(
  slug: string,
  archivedSlugs: Set<string>,
  setArchivedSlugs: React.Dispatch<React.SetStateAction<Set<string>>>,
  location?: SessionLocation,
): Promise<void> {
  const archiveKey = archiveSessionKey(slug, location);
  const targetId = location?.kind === "ssh" ? location.id : undefined;
  const query = targetId ? `?targetId=${encodeURIComponent(targetId)}` : "";
  const isArchived = archivedSlugs.has(archiveKey);
  setArchivedSlugs((prev) => {
    const next = new Set(prev);
    if (isArchived) {
      next.delete(archiveKey);
    } else {
      next.add(archiveKey);
    }
    return next;
  });
  try {
    const resp = await fetch(`/api/archive/${encodeURIComponent(slug)}${query}`, {
      method: isArchived ? "DELETE" : "POST",
    });
    if (!resp.ok) throw new Error("Archive toggle failed");
  } catch (err) {
    console.error("Archive toggle failed:", getErrorMessage(err));
    setArchivedSlugs((prev) => {
      const next = new Set(prev);
      if (isArchived) {
        next.add(archiveKey);
      } else {
        next.delete(archiveKey);
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
  const projectsByLabel = new Map<string, string[]>();
  for (const p of projects) {
    const label = specialProjectLabel(p) || shortenPath(p);
    labels.set(p, label);
    const matchingProjects = projectsByLabel.get(label) || [];
    matchingProjects.push(p);
    projectsByLabel.set(label, matchingProjects);
  }
  for (const matchingProjects of projectsByLabel.values()) {
    if (matchingProjects.length < 2) continue;
    for (const project of matchingProjects) {
      // The compact path can still collide for long projects that share their
      // first and last segments. Fall back to the full path rather than
      // showing two indistinguishable project rows.
      labels.set(project, project);
    }
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
export function agentWorktreeParent(project: string): string | null {
  return sharedAgentWorktreeParent(project);
}

/**
 * Scratch workspaces created one per automated run — SDK agents, PR-review
 * worktrees, temp dirs. Each run gets its own directory, so left alone they
 * outnumber real projects several times over while telling the reader nothing:
 * the run id is the only thing separating them. They roll up under the
 * directory that holds them, which is the level a human would recognize.
 */
export function agentRunWorkspaceParent(project: string): string | null {
  return sharedAgentRunWorkspaceParent(project);
}

export function isAgentRunWorkspace(project: string, identity?: ProjectIdentity): boolean {
  return isAutomatedProject(project, identity);
}

export function rollupProject(project: string, identity?: ProjectIdentity): string {
  return projectIdentityKey(project, identity);
}

export function projectDisplayName(project: string, identity?: ProjectIdentity): string {
  if (identity?.key === project && identity.displayName) return identity.displayName;
  return projectName(project);
}

export interface TopProjectEntry {
  project: string;
  projectIdentity?: ProjectIdentity;
  location?: SessionLocation;
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
    const parentProject =
      agentWorktreeParent(p.project) ??
      (rollupAgentRuns ? rollupProject(p.project, p.projectIdentity) : null) ??
      p.project;
    const locationKey = p.location?.kind === "ssh" ? `ssh:${p.location.id}` : "local";
    const key = `${locationKey}\0${parentProject}`;
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
      existing.projectIdentity = mergeProjectIdentities(
        existing.projectIdentity,
        p.projectIdentity,
      );
      if ((p.lastActivity || "") > (existing.lastActivity || "")) {
        existing.lastActivity = p.lastActivity;
      }
      for (const [day, count] of Object.entries(p.sessionsPerDay)) {
        existing.sessionsPerDay[day] = (existing.sessionsPerDay[day] || 0) + count;
      }
    } else {
      byParent.set(key, {
        ...p,
        project: parentProject,
        projectIdentity:
          key === p.project
            ? p.projectIdentity
            : mergeProjectIdentities(undefined, p.projectIdentity),
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
  const cursorAutomation = normalized.match(/^cursor-sdk:([^:]+):(.+)$/);
  if (cursorAutomation) {
    const workflowLabel = cursorSdkWorkflowLabel(cursorAutomation[1]);
    if (cursorAutomation[2] === "all") return `Automated · ${workflowLabel}`;
    return `Automated · ${cursorAutomation[2]} · ${workflowLabel}`;
  }
  if (/\/\.cursor\/projects\/.+\/terminals$/.test(normalized)) return "Cursor Terminals";
  if (/\/\.cursor\/extensions\//.test(normalized)) return "Cursor Extension";
  return null;
}
