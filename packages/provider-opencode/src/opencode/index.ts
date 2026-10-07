import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { opencodeDataDir } from "./sqlite.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverOpencodeSessions } from "./discover.js";
import { parseOpencodeSession } from "./parser.js";

export const opencodeProvider: Provider = {
  name: "opencode",
  displayName: "OpenCode",
  detect: async () => hasAnySourcePath([opencodeDataDir()]),
  discover: discoverOpencodeSessions,
  parse: parseOpencodeSession,
};
