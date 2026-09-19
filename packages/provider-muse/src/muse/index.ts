import type { Provider } from "@vibe-replay/provider-contract";
import { discoverMuseSessions } from "./discover.js";
import { parseMuseSession } from "./parser.js";

export { discoverMuseSessions } from "./discover.js";
export { isRuntimeInjectionSource, parseMuseLines, parseMuseSession } from "./parser.js";
export { mapMuseToolArgs, mapMuseToolName } from "./tool-mapping.js";
export { getMuseAgentsDir, getMuseAgentsDirs, readMuseSessionMeta } from "./config.js";

export const museProvider: Provider = {
  name: "muse",
  displayName: "Muse",
  discover: () => discoverMuseSessions(),
  parse: (filePaths, sessionInfo) => parseMuseSession(filePaths, sessionInfo),
};
