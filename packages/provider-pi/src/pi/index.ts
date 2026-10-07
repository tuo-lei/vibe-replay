import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { getPiSessionsDirs } from "./config.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverPiSessions } from "./discover.js";
import { parsePiSession } from "./parser.js";

export const piProvider: Provider = {
  name: "pi",
  displayName: "Pi",
  detect: async () => hasAnySourcePath(getPiSessionsDirs()),
  discover: () => discoverPiSessions(),
  parse: parsePiSession,
};
