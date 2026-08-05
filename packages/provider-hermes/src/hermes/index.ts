import type { Provider } from "@vibe-replay/provider-contract";
import { discoverHermesSessions } from "./discover.js";
import { parseHermesSession } from "./parser.js";

export const hermesProvider: Provider = {
  name: "hermes",
  displayName: "Hermes",
  discover: discoverHermesSessions,
  parse: parseHermesSession,
};
