import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { join } from "node:path";
import { claudeDataDirs } from "../claude-data-paths.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverClaudeCoworkSessions } from "./discover.js";
import { parseClaudeCoworkSession } from "./parser.js";

export const claudeCoworkProvider: Provider = {
  name: "claude-cowork",
  displayName: "Claude Cowork",
  detect: async () =>
    hasAnySourcePath((await claudeDataDirs()).map((dir) => join(dir, "local-agent-mode-sessions"))),
  discover: discoverClaudeCoworkSessions,
  parse: parseClaudeCoworkSession,
};
