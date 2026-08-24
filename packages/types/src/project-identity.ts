/**
 * Stable identity and classification for a session's project/workspace.
 *
 * Providers keep the raw workspace path on the session. These fields describe
 * the human-level project that dashboard aggregations should use instead.
 */
export type ProjectIdentityKind =
  | "project"
  | "claude-worktree"
  | "agent-run"
  | "cursor-sdk-automation";

export interface ProjectIdentity {
  /** Stable key used when aggregating sessions and project insights. */
  key: string;
  kind: ProjectIdentityKind;
  isAutomated: boolean;
  /** A human-readable label for synthetic automation groups. */
  displayName?: string;
  /** Provider workflow that created the workspace, when known. */
  workflowId?: string;
  /** Repository targeted by the workflow, when known or safely inferred. */
  repository?: string;
  /** PR associated with this individual run, when known. */
  prNumber?: number;
  /** Provider-native agent identity, when available. */
  agentId?: string;
}

export interface ProjectIdentityHints {
  provider?: string;
  hasSdk?: boolean;
  sdkAgentId?: string;
  sdkAgentName?: string;
  sdkWorkspaceRef?: string;
  gitRepo?: string;
}

const AGENT_WORKTREE_RE = /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/;

const RUN_ID_SUFFIX_RE =
  /(?:^|-)(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]{12,}$)[0-9]*[a-f][0-9a-f]*)$/i;

/**
 * These are storage roots used by the Cursor SDK automation repository. The
 * workflow name is still required when possible; the root alone is only a
 * fallback for an SDK artifact whose agent name is unavailable.
 */
const CURSOR_SDK_AUTOMATION_PATH_RE =
  /(?:^|\/)(?:cursor-coworktrees\/worktrees|\.cursor-sdk-control\/(?:artifacts|context-worktrees|worktrees))(?:\/|$)/i;

const CURSOR_SDK_WORKFLOWS: Array<{ id: string; pattern: RegExp }> = [
  { id: "github-pr-review", pattern: /github[-_]pr[-_]review/i },
  { id: "google-drive-search", pattern: /google[-_]drive[-_]search/i },
  { id: "google-doc-review", pattern: /google[-_]doc[-_]review/i },
  { id: "source-extraction-sentry", pattern: /source[-_]extraction[-_]sentry/i },
  {
    id: "source-extraction-slack-inbox",
    pattern: /source[-_]extraction[-_]slack[-_]inbox/i,
  },
  { id: "sentry-triage", pattern: /sentry[-_]triage/i },
  { id: "slack-inbox", pattern: /slack[-_]inbox/i },
];

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathLeaf(value: string): string {
  const normalized = normalizePath(value);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function findCursorSdkWorkflow(values: readonly string[]): string | undefined {
  for (const value of values) {
    if (!value) continue;
    for (const workflow of CURSOR_SDK_WORKFLOWS) {
      if (workflow.pattern.test(value)) return workflow.id;
    }
  }
  return undefined;
}

function extractCursorSdkPrNumber(
  values: readonly string[],
  workflowId?: string,
): number | undefined {
  if (workflowId !== "github-pr-review") return undefined;
  for (const value of values) {
    if (!value) continue;
    const match = pathLeaf(value).match(/(?:^|[-_])(\d+)(?:[-_][0-9a-f]{12,})?$/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

function extractCursorSdkTarget(values: readonly string[], prNumber?: number): string | undefined {
  if (prNumber === undefined) return undefined;
  for (const value of values) {
    if (!value) continue;
    const leaf = pathLeaf(value);
    const markers = [...leaf.matchAll(/github[-_]pr[-_]review[-_]/gi)];
    const marker = markers.at(-1);
    if (!marker || marker.index === undefined) continue;
    const suffix = leaf.slice(marker.index + marker[0].length);
    const withoutDigest = suffix.replace(/[-_][0-9a-f]{12,}$/i, "");
    const withoutPr = withoutDigest.replace(new RegExp(`[-_]${prNumber}$`), "");
    if (withoutPr) return withoutPr;
  }
  return undefined;
}

function inferRepositoryFromTarget(target?: string): string | undefined {
  if (!target) return undefined;
  const separator = target.indexOf("-");
  if (separator <= 0 || separator === target.length - 1) return target;
  // Cursor SDK worktree IDs are generated from `owner/repo#number`. This is a
  // conservative fallback for names such as `Roblox-ros`; an actual git
  // remote remains preferred whenever the worktree is still available.
  return `${target.slice(0, separator)}/${target.slice(separator + 1)}`;
}

function cursorSdkGroupParent(project: string, sdkWorkspaceRef?: string): string {
  // Prefer the display-safe project path. The SDK workspace ref is often an
  // absolute path and must not leak into a canonical key when no repository
  // or workflow target can be inferred.
  const candidate = project || sdkWorkspaceRef || "";
  const normalized = normalizePath(candidate);
  const worktrees = normalized.match(
    /^(.*\/)(?:cursor-coworktrees\/worktrees|\.cursor-sdk-control\/(?:artifacts|context-worktrees|worktrees))(?:\/|$)/i,
  );
  return worktrees?.[1]?.replace(/\/$/, "") || normalized;
}

function isCursorSdkPath(value: string): boolean {
  return CURSOR_SDK_AUTOMATION_PATH_RE.test(normalizePath(value));
}

/**
 * Return the parent project for a Claude Code worktree.
 */
export function agentWorktreeParent(project: string): string | null {
  const clean = project.replace(/[\\/]+$/, "");
  return clean.match(AGENT_WORKTREE_RE)?.[1] || null;
}

/**
 * Return the directory holding a generic one-run workspace.
 *
 * Numeric-only suffixes intentionally remain excluded. A path such as
 * `ros-11883` is much more likely to be a real project or PR-number directory
 * than a generated run ID unless it is identified by the Cursor SDK rules
 * above.
 */
export function agentRunWorkspaceParent(project: string): string | null {
  const clean = project.replace(/[\\/]+$/, "");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (slash <= 0) return null;
  if (!RUN_ID_SUFFIX_RE.test(clean.slice(slash + 1))) return null;
  const parent = clean.slice(0, slash);
  return /^[A-Za-z]:$/.test(parent) ? null : parent;
}

export function isCursorSdkAutomationPath(project: string): boolean {
  return isCursorSdkPath(project);
}

/**
 * Classify a project without making filesystem assumptions.
 *
 * Cursor SDK automation gets a repository/workflow group key, so multiple
 * ephemeral PR worktrees become one dashboard project. The individual PR
 * number remains attached to the session identity and can be counted without
 * making every PR a separate project row.
 */
export function classifyProject(
  project: string,
  hints: ProjectIdentityHints = {},
): ProjectIdentity {
  const projectValue = project || "";
  const sdkValues = [hints.sdkAgentName || "", hints.sdkWorkspaceRef || "", projectValue];
  const sdkPath = sdkValues.some(isCursorSdkPath);
  const workflowId = hints.hasSdk || sdkPath ? findCursorSdkWorkflow(sdkValues) : undefined;

  if (workflowId || sdkPath) {
    const resolvedWorkflow = workflowId || "cursor-sdk";
    const prNumber = extractCursorSdkPrNumber(sdkValues, resolvedWorkflow);
    const target = extractCursorSdkTarget(sdkValues, prNumber);
    const repository = hints.gitRepo?.trim() || inferRepositoryFromTarget(target) || undefined;
    const group = repository || target || cursorSdkGroupParent(projectValue, hints.sdkWorkspaceRef);
    const key = `cursor-sdk:${resolvedWorkflow}:${group || "unknown"}`;
    const displayTarget = repository || target;

    return {
      key,
      kind: "cursor-sdk-automation",
      isAutomated: true,
      displayName: displayTarget
        ? `Automated · ${displayTarget}`
        : `Automated · ${resolvedWorkflow}`,
      workflowId: resolvedWorkflow,
      repository,
      prNumber,
      agentId: hints.sdkAgentId,
    };
  }

  const claudeParent = agentWorktreeParent(projectValue);
  if (claudeParent) {
    return {
      key: claudeParent,
      kind: "claude-worktree",
      isAutomated: true,
    };
  }

  const runParent = agentRunWorkspaceParent(projectValue);
  if (runParent) {
    return {
      key: runParent,
      kind: "agent-run",
      isAutomated: true,
    };
  }

  return {
    key: projectValue,
    kind: "project",
    isAutomated: false,
  };
}

export function projectIdentityKey(project: string, identity?: ProjectIdentity): string {
  return identity?.key || classifyProject(project).key;
}

export function isAutomatedProject(project: string, identity?: ProjectIdentity): boolean {
  return identity?.isAutomated ?? classifyProject(project).isAutomated;
}

/**
 * Merge metadata from entries that share a canonical project key.
 * A PR or agent ID is only retained when every merged entry agrees.
 */
export function mergeProjectIdentities(
  first: ProjectIdentity | undefined,
  second: ProjectIdentity | undefined,
): ProjectIdentity | undefined {
  if (!first) return second;
  if (!second || first.key !== second.key) return first;

  const merged: ProjectIdentity = {
    ...first,
    displayName: first.displayName || second.displayName,
    workflowId: first.workflowId || second.workflowId,
    repository: first.repository || second.repository,
  };
  if (first.prNumber !== second.prNumber) delete merged.prNumber;
  if (first.agentId !== second.agentId) delete merged.agentId;
  return merged;
}
