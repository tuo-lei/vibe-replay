import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { hermesRootDir } from "./sqlite.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverHermesSessions } from "./discover.js";
import { parseHermesSession } from "./parser.js";

export const hermesProvider: Provider = {
  name: "hermes",
  displayName: "Hermes",
  detect: async () => hasAnySourcePath([hermesRootDir()]),
  discover: discoverHermesSessions,
  parse: parseHermesSession,
};
