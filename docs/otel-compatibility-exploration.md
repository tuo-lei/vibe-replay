# OpenTelemetry export

`vibe-replay export <session> --format otlp-json` exports a saved session as an
OTLP/JSON `ExportLogsServiceRequest`. Use `--stdout` to pipe it to an OTLP JSON
receiver or transform it with an OpenTelemetry Collector pipeline:

```sh
vibe-replay export <session-id> --format otlp-json --stdout > session.otlp.json
```

The export is a historical projection of data persisted by coding-agent
providers. It does not require those agents to have been instrumented with
OpenTelemetry. It emits tool-call and per-turn token-usage log records when the
saved replay has that evidence. Log records use GenAI semantic attributes where
they apply, with `vibe_replay.*` attributes for source provider and data
quality.

## Fidelity and limitations

- Tool names, call outcomes, timestamps, and durations are emitted only when
  saved in the replay. Unknown outcomes stay `unknown`; missing timestamps and
  durations are omitted and marked unavailable.
- Nested subagent tool scenes are included; delegation wrapper calls are
  excluded so the same work is not counted twice.
- Token counts are emitted per turn when present. `gen_ai.usage.input_tokens`
  includes cache-read and cache-write input, as the GenAI convention
  specifies; `vibe_replay.usage.uncached_input_tokens` preserves vibe-replay's
  separately normalized uncached portion.
- The export does not fabricate trace IDs, parent spans, causal relationships,
  tool call IDs, timestamps, or duration measurements. Token usage records carry
  a timestamp only when the provider recorded one and the parser retained it;
  compaction segments retain their segment index, and timestamp-derived tool
  durations are marked as estimated. Synthetic model
  placeholders are omitted from `gen_ai.response.model` and identified through
  `vibe_replay.quality.model`.
  These records therefore appear under OTLP logs, not as reconstructed traces.
- Session-level estimated cost is not currently exported. It has no standard
  GenAI log field and should only be added with an explicit unit and quality
  contract.
- The default export excludes prompts, assistant text, thinking, tool
  arguments/results, file paths, project paths, and local repository identity.
  It includes the source session ID as `gen_ai.conversation.id`; treat that
  identifier as potentially sensitive when sharing exports.

The current GenAI semantic conventions cover tool execution and token usage,
but the conventions remain in Development. See the [GenAI span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
and [GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/).

## Data source

The exporter uses the saved `ReplaySession` scenes and turn statistics. Detailed
scanner `UsageEvent`s are not included in the replay payload, so the first
version deliberately does not depend on the separate usage index or introduce
a second provider parsing path. Tool calls without a recorded result are
exported with partial status quality; tool calls with result evidence preserve
success/error status.
