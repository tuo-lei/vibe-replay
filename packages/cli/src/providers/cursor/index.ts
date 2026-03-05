import type { Provider } from "../types.js";
import { discoverCursorSessions } from "./discover.js";
import { parseCursorSession } from "./parser.js";

export const cursorProvider: Provider = {
  name: "cursor",
  displayName: "Cursor",
  discover: discoverCursorSessions,
  parse: (filePaths, sessionInfo) => parseCursorSession(filePaths, sessionInfo),
};
