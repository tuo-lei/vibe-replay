import type { Provider } from "../types.js";
import { discoverClaudeCodeSessions } from "./discover.js";
import { parseClaudeCodeSession } from "./parser.js";

export const claudeCodeProvider: Provider = {
  name: "claude-code",
  displayName: "Claude Code",
  discover: discoverClaudeCodeSessions,
  parse: parseClaudeCodeSession,
};
