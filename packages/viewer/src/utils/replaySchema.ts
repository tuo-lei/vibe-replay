import { REPLAY_SCHEMA_VERSION, type ReplaySession } from "../types";

const SCENE_TYPES = new Set([
  "user-prompt",
  "compaction-summary",
  "context-injection",
  "thinking",
  "text-response",
  "tool-call",
]);

/** Validate replay identity, scene envelopes, and forward schema compatibility. */
export function parseReplaySession(value: unknown): ReplaySession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid replay: expected an object");
  }
  const replay = value as Record<string, unknown>;
  const version = replay.schemaVersion;
  if (
    version !== undefined &&
    (!Number.isInteger(version) ||
      (version as number) < 1 ||
      (version as number) > REPLAY_SCHEMA_VERSION)
  ) {
    throw new Error(
      `Unsupported replay schema version: ${String(version)} (viewer supports ${REPLAY_SCHEMA_VERSION})`,
    );
  }

  const meta = replay.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Invalid replay: missing meta object");
  }
  const typedMeta = meta as Record<string, unknown>;
  if (typeof typedMeta.sessionId !== "string" || !typedMeta.sessionId) {
    throw new Error("Invalid replay: missing meta.sessionId");
  }
  if (typeof typedMeta.provider !== "string" || !typedMeta.provider) {
    throw new Error("Invalid replay: missing meta.provider");
  }
  if (!Array.isArray(replay.scenes)) {
    throw new Error("Invalid replay: missing scenes array");
  }
  for (let index = 0; index < replay.scenes.length; index++) {
    const scene = replay.scenes[index];
    if (
      !scene ||
      typeof scene !== "object" ||
      Array.isArray(scene) ||
      typeof (scene as { type?: unknown }).type !== "string" ||
      !SCENE_TYPES.has((scene as { type: string }).type)
    ) {
      throw new Error(`Invalid replay: unsupported scene at index ${index}`);
    }
  }
  return value as ReplaySession;
}
