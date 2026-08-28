import type { SessionInfo } from "./types.js";

const RESUMABLE_PROVIDERS = new Set(["claude-code", "claude-desktop"]);

function logicalSessionKey(session: SessionInfo): string {
  const locationScope = session.location?.kind === "ssh" ? `${session.location.id}::` : "";
  if (RESUMABLE_PROVIDERS.has(session.provider)) {
    return `${locationScope}${session.provider}::${session.project}::${session.slug}`;
  }
  return `${locationScope}${session.provider}::${session.sessionId || session.filePath}`;
}

/** Merge only provider formats that intentionally split one logical session across resume files. */
export function mergeSameSessions(sessions: SessionInfo[]): SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = logicalSessionKey(session);
    groups.set(key, [...(groups.get(key) || []), session]);
  }

  const result: SessionInfo[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    group.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latest = group[0];
    const filePaths = [
      ...new Set(
        group
          .slice()
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .flatMap((session) => session.filePaths),
      ),
    ];
    const promptCount = group.some((session) => session.promptCount != null)
      ? group.reduce((sum, session) => sum + (session.promptCount || 0), 0)
      : undefined;
    const toolCallCount = group.some((session) => session.toolCallCount != null)
      ? group.reduce((sum, session) => sum + (session.toolCallCount || 0), 0)
      : undefined;
    const compactionCount = group.some((session) => session.compactionCount != null)
      ? group.reduce((sum, session) => sum + (session.compactionCount || 0), 0)
      : undefined;
    const transcriptStatus = group.some((session) => !session.transcriptStatus)
      ? undefined
      : group.some((session) => session.transcriptStatus === "no-prompts")
        ? "no-prompts"
        : "unreadable";

    result.push({
      ...latest,
      lineCount: group.reduce((sum, session) => sum + session.lineCount, 0),
      fileSize: group.reduce((sum, session) => sum + session.fileSize, 0),
      filePaths,
      toolPaths: [...new Set(group.flatMap((session) => session.toolPaths || []))],
      promptCount,
      toolCallCount,
      compactionCount,
      transcriptStatus,
    });
  }

  result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return result;
}
