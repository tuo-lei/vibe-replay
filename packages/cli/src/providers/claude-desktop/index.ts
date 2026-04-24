import { parseClaudeCodeSession } from "../claude-code/parser.js";
import type { Provider } from "../types.js";
import { discoverClaudeDesktopSessions } from "./discover.js";

export const claudeDesktopProvider: Provider = {
  name: "claude-desktop",
  displayName: "Claude Desktop",
  discover: discoverClaudeDesktopSessions,
  parse: parseClaudeCodeSession,
};
