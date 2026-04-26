import type { Provider } from "../types.js";
import { discoverCodexSessions } from "./discover.js";
import { parseCodexSession } from "./parser.js";

export const codexProvider: Provider = {
  name: "codex",
  displayName: "Codex",
  discover: discoverCodexSessions,
  parse: parseCodexSession,
};
