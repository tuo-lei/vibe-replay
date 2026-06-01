import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const CURSOR_CHATS_DIR = join(homedir(), ".cursor", "chats");

export function createRetryableInit<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return async () => {
    if (!promise) {
      promise = factory().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

export function workspaceHash(absolutePath: string): string {
  return createHash("md5").update(absolutePath).digest("hex");
}

export function storeDbPath(workspacePath: string, sessionId: string): string {
  return join(CURSOR_CHATS_DIR, workspaceHash(workspacePath), sessionId, "store.db");
}
