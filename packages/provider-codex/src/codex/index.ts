import type { Provider } from "@vibe-replay/provider-contract";
import { discoverCodexSessions } from "./discover.js";
import { parseCodexSession } from "./parser.js";

export const codexProvider: Provider = {
  name: "codex",
  displayName: "Codex",
  discover: discoverCodexSessions,
  parse: parseCodexSession,
};
