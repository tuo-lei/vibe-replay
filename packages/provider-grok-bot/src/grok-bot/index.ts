import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import {
  getGrokBotTranscriptRoots,
  getGrokBotClientPersistenceDir,
  defaultGrokBotClientPersistenceDir,
} from "./config.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverGrokBotSessions } from "./discover.js";
import { parseGrokBotSession } from "./parser.js";

export const grokBotProvider: Provider = {
  name: "grok-bot",
  displayName: "Grok Bot",
  detect: async () =>
    hasAnySourcePath([
      ...getGrokBotTranscriptRoots(),
      getGrokBotClientPersistenceDir() ?? defaultGrokBotClientPersistenceDir(),
    ]),
  discover: () => discoverGrokBotSessions(),
  parse: parseGrokBotSession,
};
