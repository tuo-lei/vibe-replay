import type { Provider } from "@vibe-replay/provider-contract";
import { discoverGrokBotSessions } from "./discover.js";
import { parseGrokBotSession } from "./parser.js";

export const grokBotProvider: Provider = {
  name: "grok-bot",
  displayName: "Grok Bot",
  discover: discoverGrokBotSessions,
  parse: parseGrokBotSession,
};
