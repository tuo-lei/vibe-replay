import { REPLAY_SCHEMA_VERSION, type ReplaySession } from "../types";

const SCENE_TYPES = new Set([
  "user-prompt",
  "compaction-summary",
  "context-injection",
  "thinking",
  "text-response",
  "tool-call",
]);

const CONTENT_SCENE_TYPES = new Set([
  "user-prompt",
  "compaction-summary",
  "context-injection",
  "thinking",
  "text-response",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateScene(scene: unknown, index: number): void {
  if (!isRecord(scene) || typeof scene.type !== "string" || !SCENE_TYPES.has(scene.type)) {
    throw new Error(`Invalid replay: unsupported scene at index ${index}`);
  }

  if (CONTENT_SCENE_TYPES.has(scene.type) && typeof scene.content !== "string") {
    throw new Error(`Invalid replay: scene ${index} is missing string content`);
  }
  if (scene.type === "user-prompt" && scene.images !== undefined) {
    if (!Array.isArray(scene.images) || scene.images.some((image) => typeof image !== "string")) {
      throw new Error(`Invalid replay: scene ${index} has invalid images`);
    }
  }
  if (scene.type === "context-injection" && scene.injectionType !== undefined) {
    if (typeof scene.injectionType !== "string") {
      throw new Error(`Invalid replay: scene ${index} has invalid injectionType`);
    }
  }
  if (scene.type === "tool-call") {
    if (typeof scene.toolName !== "string") {
      throw new Error(`Invalid replay: scene ${index} is missing toolName`);
    }
    if (!isRecord(scene.input)) {
      throw new Error(`Invalid replay: scene ${index} is missing tool input`);
    }
    if (typeof scene.result !== "string") {
      throw new Error(`Invalid replay: scene ${index} is missing tool result`);
    }
  }
}

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
    validateScene(replay.scenes[index], index);
  }
  return value as ReplaySession;
}
