import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { join } from "node:path";
import { getCodexHome, getStateDbPath } from "./discover.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverCodexSessions } from "./discover.js";
import { parseCodexSession } from "./parser.js";

export const codexProvider: Provider = {
  name: "codex",
  displayName: "Codex",
  detect: async () => hasAnySourcePath([join(getCodexHome(), "sessions"), getStateDbPath()]),
  discover: () => discoverCodexSessions(),
  parse: parseCodexSession,
};
