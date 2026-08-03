import type { Provider } from "@vibe-replay/provider-contract";
import { discoverOpencodeSessions } from "./discover.js";
import { parseOpencodeSession } from "./parser.js";

export const opencodeProvider: Provider = {
  name: "opencode",
  displayName: "OpenCode",
  discover: discoverOpencodeSessions,
  parse: parseOpencodeSession,
};
