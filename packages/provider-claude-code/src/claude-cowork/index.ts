import type { Provider } from "@vibe-replay/provider-contract";
import { discoverClaudeCoworkSessions } from "./discover.js";
import { parseClaudeCoworkSession } from "./parser.js";

export const claudeCoworkProvider: Provider = {
  name: "claude-cowork",
  displayName: "Claude Cowork",
  discover: discoverClaudeCoworkSessions,
  parse: parseClaudeCoworkSession,
};
