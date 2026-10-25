import type { ReplaySession, Scene, TokenUsage } from "@vibe-replay/types";

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

interface OtlpLogRecord {
  eventName?: string;
  timeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body: OtlpValue;
  attributes: OtlpAttribute[];
}

function attr(
  key: string,
  value: string | number | boolean | undefined,
): OtlpAttribute | undefined {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return;
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return {
    key,
    value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
  };
}

function attributes(
  entries: Array<[string, string | number | boolean | undefined]>,
): OtlpAttribute[] {
  return entries.flatMap(([key, value]) => {
    const result = attr(key, value);
    return result ? [result] : [];
  });
}

function timeUnixNano(timestamp: string | undefined): string | undefined {
  if (!timestamp) return;
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return;
  return String(BigInt(milliseconds) * 1_000_000n);
}

function tokenAttributes(usage: TokenUsage): OtlpAttribute[] {
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return attributes([
    ["gen_ai.usage.input_tokens", totalInput],
    ["gen_ai.usage.output_tokens", usage.outputTokens],
    ["gen_ai.usage.cache_read.input_tokens", usage.cacheReadTokens],
    ["gen_ai.usage.cache_write.input_tokens", usage.cacheCreationTokens],
    ["vibe_replay.usage.uncached_input_tokens", usage.inputTokens],
  ]);
}

function toolLogRecord(
  scene: Extract<Scene, { type: "tool-call" }>,
  replay: ReplaySession,
  parentAgentId?: string,
): OtlpLogRecord {
  const hasResultEvidence =
    scene.hasResult === true ||
    (scene.hasResult === undefined && scene.resultUnavailable !== true && scene.result.length > 0);
  const status = scene.isError ? "error" : hasResultEvidence ? "success" : "unknown";
  const timestamp = timeUnixNano(scene.timestamp);
  const durationQuality =
    scene.durationMs === undefined
      ? "unavailable"
      : scene.durationSource === "provider"
        ? "exact"
        : scene.durationSource === "timestamp"
          ? "estimated"
          : "unknown";
  return {
    eventName: "vibe_replay.tool_call",
    ...(timestamp ? { timeUnixNano: timestamp } : {}),
    ...(scene.isError ? { severityNumber: 17, severityText: "ERROR" } : {}),
    body: { stringValue: "vibe_replay.tool_call" },
    attributes: attributes([
      ["event.name", "vibe_replay.tool_call"],
      ["event.domain", "vibe_replay"],
      ["gen_ai.conversation.id", replay.meta.sessionId],
      ["gen_ai.operation.name", "execute_tool"],
      ["gen_ai.tool.name", scene.toolName],
      ["gen_ai.agent.id", parentAgentId],
      ["vibe_replay.source.provider", replay.meta.provider],
      ["vibe_replay.tool.status", status],
      ["vibe_replay.quality.status", status === "unknown" ? "partial" : "exact"],
      ["vibe_replay.quality.timestamp", timestamp ? "exact" : "unavailable"],
      ["vibe_replay.tool.duration_ms", scene.durationMs],
      ["vibe_replay.quality.duration", durationQuality],
      ["vibe_replay.duration.source", scene.durationSource],
    ]),
  };
}

function tokenLogRecord(
  turnIndex: number,
  segmentIndex: number | undefined,
  usage: TokenUsage,
  model: string | undefined,
  timestamp: string | undefined,
  replay: ReplaySession,
): OtlpLogRecord {
  const normalizedModel = model === "<synthetic>" ? undefined : model;
  const time = timeUnixNano(timestamp);
  return {
    eventName: "vibe_replay.model_usage",
    ...(time ? { timeUnixNano: time } : {}),
    body: { stringValue: "vibe_replay.model_usage" },
    attributes: [
      ...attributes([
        ["event.name", "vibe_replay.model_usage"],
        ["event.domain", "vibe_replay"],
        ["gen_ai.conversation.id", replay.meta.sessionId],
        ["gen_ai.response.model", normalizedModel],
        ["vibe_replay.source.provider", replay.meta.provider],
        ["vibe_replay.turn.index", turnIndex],
        ["vibe_replay.turn.segment_index", segmentIndex],
        ["vibe_replay.quality.timestamp", time ? "exact" : "unavailable"],
        [
          "vibe_replay.quality.model",
          normalizedModel ? "exact" : model === "<synthetic>" ? "synthetic" : "unavailable",
        ],
      ]),
      ...tokenAttributes(usage),
    ],
  };
}

/** Build an OTLP/JSON ExportLogsServiceRequest from evidence in a saved replay. */
export function generateOtlpJson(replay: ReplaySession, pretty = true): string {
  const toolScenes = (
    scenes: readonly Scene[],
    parentAgentId?: string,
  ): Array<{ scene: Extract<Scene, { type: "tool-call" }>; parentAgentId?: string }> =>
    scenes.flatMap((scene) => {
      if (scene.type !== "tool-call") return [];
      return [
        ...(!scene.isToolContainer ? [{ scene, parentAgentId }] : []),
        ...(scene.subAgent ? toolScenes(scene.subAgent.scenes, scene.subAgent.agentId) : []),
      ];
    });
  const toolRecords = toolScenes(replay.scenes).map(({ scene, parentAgentId }) =>
    toolLogRecord(scene, replay, parentAgentId),
  );
  const tokenRecords = (replay.meta.stats.turnStats ?? []).flatMap((turn) =>
    turn.tokenUsage
      ? [
          tokenLogRecord(
            turn.turnIndex,
            turn.segmentIndex,
            turn.tokenUsage,
            turn.model,
            turn.timestamp,
            replay,
          ),
        ]
      : [],
  );
  const logRecords = [...toolRecords, ...tokenRecords].sort((left, right) => {
    const leftTime = left.timeUnixNano ? BigInt(left.timeUnixNano) : undefined;
    const rightTime = right.timeUnixNano ? BigInt(right.timeUnixNano) : undefined;
    if (leftTime === undefined) return rightTime === undefined ? 0 : 1;
    if (rightTime === undefined) return -1;
    return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
  });

  return JSON.stringify(
    {
      resourceLogs: [
        {
          resource: {
            attributes: attributes([
              ["service.name", "vibe-replay"],
              ["service.version", replay.meta.generator?.version],
              ["vibe_replay.source.provider", replay.meta.provider],
            ]),
          },
          scopeLogs: [
            {
              scope: { name: "vibe-replay", version: replay.meta.generator?.version },
              logRecords,
            },
          ],
        },
      ],
    },
    null,
    pretty ? 2 : undefined,
  );
}
