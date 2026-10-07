import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverClaudeCodeSessions } from "./discover.js";
import { parseClaudeCodeSession } from "./parser.js";

export const claudeCodeProvider: Provider = {
  name: "claude-code",
  displayName: "Claude Code",
  detect: async () => hasAnySourcePath([join(homedir(), ".claude", "projects")]),
  discover: () => discoverClaudeCodeSessions(),
  parse: parseClaudeCodeSession,
};
