import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { join } from "node:path";
import { claudeDataDirs } from "../claude-data-paths.js";
import { parseClaudeCodeSession } from "../claude-code/parser.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverClaudeDesktopSessions } from "./discover.js";

export const claudeDesktopProvider: Provider = {
  name: "claude-desktop",
  displayName: "Claude Desktop",
  detect: async () =>
    hasAnySourcePath((await claudeDataDirs()).map((dir) => join(dir, "claude-code-sessions"))),
  discover: discoverClaudeDesktopSessions,
  parse: parseClaudeCodeSession,
};
