import type { Provider } from "../types.js";
import { discoverPiSessions } from "./discover.js";
import { parsePiSession } from "./parser.js";

export const piProvider: Provider = {
  name: "pi",
  displayName: "Pi",
  discover: discoverPiSessions,
  parse: parsePiSession,
};
