import type { Provider } from "@vibe-replay/provider-contract";
import { discoverPiSessions } from "./discover.js";
import { parsePiSession } from "./parser.js";

export const piProvider: Provider = {
  name: "pi",
  displayName: "Pi",
  discover: discoverPiSessions,
  parse: parsePiSession,
};
