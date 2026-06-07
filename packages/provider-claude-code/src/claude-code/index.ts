import type { Provider } from "@vibe-replay/provider-contract";
import { discoverClaudeCodeSessions } from "./discover.js";
import { parseClaudeCodeSession } from "./parser.js";

export const claudeCodeProvider: Provider = {
  name: "claude-code",
  displayName: "Claude Code",
  discover: discoverClaudeCodeSessions,
  parse: parseClaudeCodeSession,
};
