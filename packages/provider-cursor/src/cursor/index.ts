import { hasAnySourcePath } from "@vibe-replay/provider-core/utils";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalStateDbCandidates } from "./sqlite-reader.js";
import { CURSOR_CHATS_DIR } from "./sqlite-io.js";
import type { Provider } from "@vibe-replay/provider-contract";
import { discoverCursorSessions } from "./discover.js";
import { parseCursorSession } from "./parser.js";

export const cursorProvider: Provider = {
  name: "cursor",
  displayName: "Cursor",
  detect: async () =>
    hasAnySourcePath([
      join(homedir(), ".cursor", "projects"),
      CURSOR_CHATS_DIR,
      ...globalStateDbCandidates(),
    ]),
  discover: discoverCursorSessions,
  parse: (filePaths, sessionInfo) => parseCursorSession(filePaths, sessionInfo),
};
