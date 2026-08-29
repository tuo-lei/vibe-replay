/**
 * AI Studio operations backed by Pi's provider registry and agent loop.
 *
 * The agent is intentionally given one structured result tool and no filesystem,
 * network, or MCP tools. That lets all AI Studio features share the same provider
 * setup while keeping replay analysis read-only.
 *
 * Output quality depends on the selected provider/model.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getAiRuntime } from "./ai-runtime.js";
import type { Annotation, OverlaySource, ReplaySession, Scene, SceneOverlay } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiSelection {
  providerId: string;
  modelId?: string;
}

export interface FeedbackItem {
  sceneIndex: number;
  title: string;
  feedback: string;
  category: "clarity" | "specificity" | "context" | "efficiency" | "iteration" | "tool-usage";
  improvedPrompt?: string;
}

export interface FrictionPoint {
  type: "misunderstood" | "wrong_approach" | "buggy_code" | "excessive_changes" | "user_unclear";
  description: string;
  turn: number;
}

export interface FeedbackResult {
  summary: string;
  score: number;
  strengths: string[];
  improvements: string[];
  feedbackItems: FeedbackItem[];
  // Session-level analysis (Phase 1A — optional for weaker models)
  outcome?:
    | "fully_achieved"
    | "mostly_achieved"
    | "partially_achieved"
    | "not_achieved"
    | "unclear";
  sessionGoal?: string;
  frictionPoints?: FrictionPoint[];
  aiPerformance?: {
    rating: "poor" | "below_average" | "average" | "good" | "excellent";
    strengths: string[];
    weaknesses: string[];
  };
}

const AI_STUDIO_OPERATION_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Session digest — condense session for AI consumption
// ---------------------------------------------------------------------------

export function buildSessionDigest(session: ReplaySession): string {
  const lines: string[] = [];
  const promptCount = session.meta.stats.userPrompts;

  // Adaptive truncation budgets based on number of prompts
  const maxPromptChars = Math.min(3000, Math.floor(25000 / Math.max(promptCount, 1)));
  const maxResponseChars = Math.min(1500, Math.floor(20000 / Math.max(promptCount, 1)));
  const maxDiffChars = Math.min(500, Math.floor(8000 / Math.max(promptCount, 1)));
  const maxBashOutputChars = Math.min(300, Math.floor(5000 / Math.max(promptCount, 1)));

  let turnNum = 0;
  let turnLines: string[] = [];
  let responseChars = 0;

  const flush = () => {
    if (turnLines.length) {
      lines.push(...turnLines, "");
      turnLines = [];
      responseChars = 0;
    }
  };

  for (let i = 0; i < session.scenes.length; i++) {
    const scene = session.scenes[i];

    if (scene.type === "user-prompt") {
      flush();
      turnNum++;
      turnLines.push(`=== TURN ${turnNum} (scene ${i}) ===`);
      turnLines.push("[USER PROMPT]:");
      const content =
        scene.content.length > maxPromptChars
          ? `${scene.content.slice(0, maxPromptChars)}\n...(truncated)`
          : scene.content;
      turnLines.push(content);
      turnLines.push("");
      turnLines.push("[ASSISTANT RESPONSE]:");
    } else if (scene.type === "thinking") {
      if (responseChars < maxResponseChars) {
        const summary =
          scene.content.length > 200 ? `${scene.content.slice(0, 200)}...` : scene.content;
        turnLines.push(`  - Thinking: ${summary}`);
        responseChars += summary.length;
      }
    } else if (scene.type === "text-response") {
      if (responseChars < maxResponseChars) {
        const budget = maxResponseChars - responseChars;
        const summary =
          scene.content.length > budget ? `${scene.content.slice(0, budget)}...` : scene.content;
        turnLines.push(`  - Text: ${summary}`);
        responseChars += summary.length;
      }
    } else if (scene.type === "tool-call") {
      if (scene.diff) {
        turnLines.push(`  - ${scene.toolName}: ${scene.diff.filePath}`);
        // Include diff content so the coach can evaluate code quality
        const diffText = scene.diff.newContent || scene.diff.oldContent;
        if (diffText && responseChars < maxResponseChars) {
          const diffPreview =
            diffText.length > maxDiffChars ? `${diffText.slice(0, maxDiffChars)}...` : diffText;
          turnLines.push(`    ${diffPreview.replace(/\n/g, "\n    ")}`);
          responseChars += diffPreview.length;
        }
      } else if (scene.bashOutput) {
        const cmd =
          scene.bashOutput.command.length > 120
            ? `${scene.bashOutput.command.slice(0, 120)}...`
            : scene.bashOutput.command;
        turnLines.push(`  - Bash: ${cmd}`);
        // Include command output so the coach can see results/errors
        if (scene.bashOutput.stdout && responseChars < maxResponseChars) {
          const output = scene.bashOutput.stdout.trim();
          if (output) {
            const outputPreview =
              output.length > maxBashOutputChars
                ? `${output.slice(0, maxBashOutputChars)}...`
                : output;
            turnLines.push(`    Output: ${outputPreview.replace(/\n/g, "\n    ")}`);
            responseChars += outputPreview.length;
          }
        }
      } else {
        const input = JSON.stringify(scene.input).slice(0, 100);
        turnLines.push(`  - ${scene.toolName}: ${input}`);
      }
    } else if (scene.type === "compaction-summary") {
      turnLines.push("  - [Context compaction — earlier context was summarized]");
    }
  }
  flush();

  // Hard cap for safety (roughly 40KB ≈ ~10000 tokens)
  const digest = lines.join("\n");
  if (digest.length > 50000) {
    return `${digest.slice(0, 50000)}\n\n... (remaining turns omitted due to length)`;
  }
  return digest;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const FEEDBACK_SCHEMA = `{
  "sessionGoal": "<string: one sentence — what the user was trying to achieve>",
  "outcome": "<fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear>",
  "frictionPoints": [
    {
      "type": "<misunderstood|wrong_approach|buggy_code|excessive_changes|user_unclear>",
      "description": "<string: what went wrong>",
      "turn": <number: which turn this happened in>
    }
  ],
  "aiPerformance": {
    "rating": "<poor|below_average|average|good|excellent>",
    "strengths": ["<string>"],
    "weaknesses": ["<string>"]
  },
  "summary": "<string: 2-3 paragraph overall assessment covering both prompting technique AND session effectiveness>",
  "score": <number 1-10>,
  "strengths": ["<string>", ...],
  "improvements": ["<string>", ...],
  "feedbackItems": [
    {
      "sceneIndex": <number: must be a user-prompt scene index from the transcript>,
      "title": "<string: short descriptive title>",
      "feedback": "<string: detailed actionable feedback>",
      "category": "<clarity|specificity|context|efficiency|iteration|tool-usage>",
      "improvedPrompt": "<string|null: rewritten prompt — REQUIRED for clarity/specificity/context>"
    }
  ]
}`;

const FEEDBACK_EXAMPLE = `{
  "sessionGoal": "Fix an authentication bug and add test coverage",
  "outcome": "mostly_achieved",
  "frictionPoints": [
    {
      "type": "misunderstood",
      "description": "AI searched the wrong directory for auth files because user didn't specify the path",
      "turn": 1
    }
  ],
  "aiPerformance": {
    "rating": "good",
    "strengths": ["Found and fixed the bug correctly once pointed to the right file"],
    "weaknesses": ["Wasted 3 tool calls searching before asking for clarification"]
  },
  "summary": "The user demonstrates good instincts for task decomposition, breaking complex work into manageable steps. However, several prompts lack specificity — the AI had to spend extra turns searching for context that could have been provided upfront. The goal was mostly achieved: the bug was fixed but tests were not added due to running out of context.",
  "score": 6,
  "strengths": [
    "Good task decomposition — complex feature was broken into clear steps",
    "Effective recovery when the AI went off-track in turn 3"
  ],
  "improvements": [
    "Include file paths when referencing specific code",
    "State expected behavior alongside the bug description",
    "Provide constraints (performance, compatibility) upfront rather than after rework"
  ],
  "feedbackItems": [
    {
      "sceneIndex": 0,
      "title": "Vague bug description",
      "feedback": "The prompt says 'fix the auth bug' without specifying the symptom, expected behavior, or relevant files. This forced the AI to spend 3 tool calls searching for the issue. Providing the error message and file path would have saved significant time.",
      "category": "context",
      "improvedPrompt": "Fix the authentication bug in src/auth/login.ts — users get 401 errors with valid credentials. The issue started after the token validation refactor last week. Expected: valid JWT tokens should pass validation."
    }
  ]
}`;

function buildFeedbackPrompt(digest: string, session: ReplaySession): string {
  const userPromptIndices = session.scenes
    .map((s, i) => (s.type === "user-prompt" ? i : -1))
    .filter((i) => i !== -1);

  const durationStr = session.meta.stats.durationMs
    ? `${Math.round(session.meta.stats.durationMs / 60000)} min`
    : "unknown";
  const costStr = session.meta.stats.costEstimate
    ? `$${session.meta.stats.costEstimate.toFixed(2)}`
    : "unknown";

  return `You are an expert AI coding coach. Analyze this recorded AI coding session and provide feedback on BOTH the user's prompting technique AND the overall session effectiveness.

## Session Info
- Provider: ${session.meta.provider}
- Model: ${session.meta.model || "unknown"}
- Project: ${session.meta.project}
- Duration: ${durationStr}
- User prompts: ${session.meta.stats.userPrompts}
- Tool calls: ${session.meta.stats.toolCalls}
- Estimated cost: ${costStr}

## Session Transcript

${digest}

## Valid User-Prompt Scene Indices
ONLY use these values for sceneIndex: [${userPromptIndices.join(", ")}]

## Step 1: Session-Level Analysis
First, assess the session as a whole:
- **Goal**: What was the user trying to achieve? (one sentence)
- **Outcome**: Was the goal achieved? (fully_achieved / mostly_achieved / partially_achieved / not_achieved / unclear)
- **Friction**: Where did things go wrong? Classify each friction point:
  - misunderstood: AI misinterpreted the user's request
  - wrong_approach: AI took wrong approach to correct goal
  - buggy_code: AI produced code that didn't work
  - excessive_changes: AI over-engineered or changed too much
  - user_unclear: User's prompt was too vague to act on
- **AI Performance**: How well did the AI perform? Rate and list specific strengths/weaknesses based on what you observe in the transcript (tool call results, code diffs, bash output).

## Step 2: Per-Prompt Analysis
For each user prompt, consider:
1. **Clarity** — Was it unambiguous? Could the AI misinterpret?
2. **Specificity** — Enough detail, file paths, constraints?
3. **Context** — Did the user explain what they're trying to achieve?
4. **Efficiency** — Could fewer or better prompts achieve the same result?
5. **Iteration** — When things went wrong, how well did the user course-correct?
6. **Tool-usage** — Did the user leverage the AI's capabilities (search, test, etc.)?

## Required Output
Call the provided submit_feedback tool exactly once with the complete result.
Do not emit a prose answer outside that tool call.

Schema:
${FEEDBACK_SCHEMA}

Example (for reference only — analyze the ACTUAL session above):
${FEEDBACK_EXAMPLE}

CRITICAL RULES:
- Do not use filesystem, network, or MCP tools. Analyze ONLY the transcript above.
- Call submit_feedback exactly once; do not output prose outside the tool call
- sceneIndex MUST be one of: [${userPromptIndices.join(", ")}]
- Provide feedback for the most impactful prompts (at least ${Math.min(userPromptIndices.length, 3)}, up to ${Math.min(userPromptIndices.length, 10)})
- score: 1 = very poor, 5 = average, 8 = strong, 10 = expert
- For feedback items with category "clarity", "specificity", or "context", you MUST provide an improvedPrompt showing a concrete rewrite
- Be constructive and encouraging, but honest
- Think step by step about each prompt in context before judging it`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const FEEDBACK_RESULT_SCHEMA = Type.Object({
  sessionGoal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  outcome: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  frictionPoints: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          type: Type.String(),
          description: Type.String(),
          turn: Type.Number(),
        }),
      ),
      Type.Null(),
    ]),
  ),
  aiPerformance: Type.Optional(
    Type.Union([
      Type.Object({
        rating: Type.String(),
        strengths: Type.Array(Type.String()),
        weaknesses: Type.Array(Type.String()),
      }),
      Type.Null(),
    ]),
  ),
  summary: Type.String(),
  score: Type.Number(),
  strengths: Type.Array(Type.String()),
  improvements: Type.Array(Type.String()),
  feedbackItems: Type.Array(
    Type.Object({
      sceneIndex: Type.Number(),
      title: Type.String(),
      feedback: Type.String(),
      category: Type.String(),
      improvedPrompt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
});

const TRANSLATION_RESULT_SCHEMA = Type.Object({
  translations: Type.Array(
    Type.Object({
      sceneIndex: Type.Number(),
      translated: Type.String(),
      unchanged: Type.Optional(Type.Boolean()),
    }),
  ),
});

const TONE_RESULT_SCHEMA = Type.Object({
  adjustments: Type.Array(
    Type.Object({
      sceneIndex: Type.Number(),
      adjusted: Type.String(),
      unchanged: Type.Optional(Type.Boolean()),
    }),
  ),
});

const PI_AGENT_SYSTEM_PROMPT = `You are the Vibe Replay AI Studio agent.

You analyze the transcript supplied in the user prompt. You do not need or have
access to files, the network, MCP servers, or any other tools. The only tool
available to you records the final structured result.

Always call the provided result tool exactly once with the complete answer.
Do not answer with prose outside that tool call.`;

function createResultTool(name: string, parameters: AgentTool["parameters"]): AgentTool {
  return {
    name,
    label: "Record AI Studio result",
    description:
      "Record the complete structured result. Call this exactly once after finishing the analysis.",
    parameters,
    execute: async () => ({
      content: [{ type: "text", text: "Result recorded." }],
      details: {},
      terminate: true,
    }),
  };
}

async function executeFeedback(
  prompt: string,
  selection: AiSelection,
  resultTool: AgentTool,
  signal?: AbortSignal,
): Promise<string> {
  const result = await getAiRuntime().runAgent({
    providerId: selection.providerId,
    modelId: selection.modelId,
    systemPrompt: PI_AGENT_SYSTEM_PROMPT,
    prompt,
    resultTool,
    signal,
    sessionId: `vibe-replay-ai-${randomUUID()}`,
    timeoutMs: AI_STUDIO_OPERATION_TIMEOUT_MS,
  });
  return result.output;
}

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

/** Parse JSON and return it only if it is a non-null, non-array object, else null. */
function parseJsonObject(json: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return asRecord(parsed);
}

/** Narrow an unknown value to a plain (non-array) object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Keep only the string members of an unknown value (non-arrays yield []). */
function stringsOnly(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Return `value` typed as `T` when it is a string present in `allowed`, else
 * undefined. The cast is justified by the runtime membership check.
 */
function asOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === "string" && (allowed as ReadonlySet<string>).has(value)
    ? (value as T)
    : undefined;
}

export function parseFeedbackResponse(
  output: string,
  session: ReplaySession,
): FeedbackResult | null {
  const json = extractJson(output);
  if (!json) return null;

  const parsed = parseJsonObject(json);
  if (!parsed) return null;

  // Validate top-level shape
  if (typeof parsed.summary !== "string" || !parsed.summary) return null;
  if (typeof parsed.score !== "number") return null;
  const summary = parsed.summary;
  const score = Math.max(1, Math.min(10, Math.round(parsed.score)));

  // Valid user-prompt scene indices
  const validIndices = new Set(
    session.scenes.map((s, i) => (s.type === "user-prompt" ? i : -1)).filter((i) => i !== -1),
  );
  const validCategories = new Set<FeedbackItem["category"]>([
    "clarity",
    "specificity",
    "context",
    "efficiency",
    "iteration",
    "tool-usage",
  ]);

  const feedbackItemsRaw = Array.isArray(parsed.feedbackItems) ? parsed.feedbackItems : [];
  const items: FeedbackItem[] = [];
  for (const rawItem of feedbackItemsRaw) {
    const raw = asRecord(rawItem);
    if (!raw) continue;
    if (typeof raw.sceneIndex !== "number") continue;
    if (!validIndices.has(raw.sceneIndex)) continue;
    if (typeof raw.title !== "string" || !raw.title) continue;
    if (typeof raw.feedback !== "string" || !raw.feedback) continue;

    items.push({
      sceneIndex: raw.sceneIndex,
      title: raw.title,
      feedback: raw.feedback,
      category: asOneOf(raw.category, validCategories) ?? "clarity",
      improvedPrompt:
        typeof raw.improvedPrompt === "string" && raw.improvedPrompt
          ? raw.improvedPrompt
          : undefined,
    });
  }

  // Parse new session-level fields (optional — graceful degradation for weaker models)
  const validOutcomes = new Set<NonNullable<FeedbackResult["outcome"]>>([
    "fully_achieved",
    "mostly_achieved",
    "partially_achieved",
    "not_achieved",
    "unclear",
  ]);
  const validFrictionTypes = new Set<FrictionPoint["type"]>([
    "misunderstood",
    "wrong_approach",
    "buggy_code",
    "excessive_changes",
    "user_unclear",
  ]);
  const validAiRatings = new Set<NonNullable<FeedbackResult["aiPerformance"]>["rating"]>([
    "poor",
    "below_average",
    "average",
    "good",
    "excellent",
  ]);

  const outcome = asOneOf(parsed.outcome, validOutcomes);
  const sessionGoal =
    typeof parsed.sessionGoal === "string" && parsed.sessionGoal ? parsed.sessionGoal : undefined;

  let frictionPoints: FrictionPoint[] | undefined;
  if (Array.isArray(parsed.frictionPoints) && parsed.frictionPoints.length > 0) {
    const filtered: FrictionPoint[] = [];
    for (const rawPoint of parsed.frictionPoints) {
      const f = asRecord(rawPoint);
      if (!f) continue;
      const type = asOneOf(f.type, validFrictionTypes);
      if (!type || typeof f.description !== "string" || typeof f.turn !== "number") continue;
      filtered.push({ type, description: f.description, turn: f.turn });
    }
    frictionPoints = filtered.length > 0 ? filtered : undefined;
  }

  let aiPerformance: FeedbackResult["aiPerformance"];
  const ap = asRecord(parsed.aiPerformance);
  if (ap) {
    const rating = asOneOf(ap.rating, validAiRatings);
    if (rating) {
      aiPerformance = {
        rating,
        strengths: stringsOnly(ap.strengths),
        weaknesses: stringsOnly(ap.weaknesses),
      };
    }
  }

  return {
    summary,
    score,
    strengths: stringsOnly(parsed.strengths),
    improvements: stringsOnly(parsed.improvements),
    feedbackItems: items,
    outcome,
    sessionGoal,
    frictionPoints,
    aiPerformance,
  };
}

/** Best-effort JSON extraction from potentially noisy output. */
export function extractJson(raw: string): string | null {
  const str = raw.trim();

  // 0. Pre-process: fix common model errors
  //    - Missing { before "sceneIndex" in feedbackItems array
  const preFixed = str.replace(/},\s*"sceneIndex"\s*:/g, '},{"sceneIndex":');

  // 1. Try raw parse (with pre-fix applied)
  for (const candidate of [preFixed, str]) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* continue */
    }
  }

  // 2. Try removing markdown fences
  const fenceMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      JSON.parse(fenceMatch[1].trim());
      return fenceMatch[1].trim();
    } catch {
      /* continue */
    }
  }

  // 3. Find balanced top-level { ... } (try pre-fixed first)
  const candidates = preFixed !== str ? [preFixed, str] : [str];
  for (const s of candidates) {
    const found = findBalancedJson(s);
    if (found) return found;
  }

  // 4. Handle truncated JSON — try to repair by closing open brackets
  for (const s of candidates) {
    const firstBrace = s.indexOf("{");
    if (firstBrace !== -1) {
      const repaired = repairTruncatedJson(s.slice(firstBrace));
      if (repaired) return repaired;
    }
  }

  return null;
}

export function findBalancedJson(str: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (start === -1) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = str.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          start = -1;
        }
      }
    }
  }

  return null;
}

/** Attempt to repair truncated JSON by closing brackets and trimming bad tails. */
export function repairTruncatedJson(str: string): string | null {
  // Strip trailing partial string/value by finding last valid JSON structure point
  // Look backwards for the last complete value boundary (, } ] or complete string)
  let candidate = str;

  // If we're mid-string, truncate to last complete key-value or array item
  const lastGoodPoints = [
    candidate.lastIndexOf("},"),
    candidate.lastIndexOf("}]"),
    candidate.lastIndexOf('"]'),
    candidate.lastIndexOf('",'),
    candidate.lastIndexOf("null,"),
    candidate.lastIndexOf("null}"),
  ];
  const lastGood = Math.max(...lastGoodPoints);

  if (lastGood > candidate.length * 0.5) {
    candidate = candidate.slice(0, lastGood + 1);
  }

  // Count unclosed brackets and add closing ones
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;
  for (const ch of candidate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
  }

  // Close what's open
  let suffix = "";
  while (brackets > 0) {
    suffix += "]";
    brackets--;
  }
  while (braces > 0) {
    suffix += "}";
    braces--;
  }

  if (!suffix) return null;

  const repaired = candidate + suffix;
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Annotation conversion
// ---------------------------------------------------------------------------

export function feedbackToAnnotations(feedback: FeedbackResult): Annotation[] {
  const now = new Date().toISOString();
  const annotations: Annotation[] = [];

  // Overall summary (attached to first scene)
  const outcomeLabel: Record<string, string> = {
    fully_achieved: "Fully Achieved",
    mostly_achieved: "Mostly Achieved",
    partially_achieved: "Partially Achieved",
    not_achieved: "Not Achieved",
    unclear: "Unclear",
  };

  const summaryParts: string[] = [];

  // Session goal + outcome header
  if (feedback.sessionGoal || feedback.outcome) {
    const goalLine = feedback.sessionGoal ? `**Goal:** ${feedback.sessionGoal}` : "";
    const outcomeLine = feedback.outcome
      ? `**Outcome:** ${outcomeLabel[feedback.outcome] || feedback.outcome}`
      : "";
    summaryParts.push([goalLine, outcomeLine].filter(Boolean).join(" · "));
    summaryParts.push("");
  }

  summaryParts.push(`## Prompting Score: ${feedback.score}/10\n`);
  summaryParts.push(feedback.summary);

  // AI performance
  if (feedback.aiPerformance) {
    const ap = feedback.aiPerformance;
    const ratingLabel: Record<string, string> = {
      poor: "Poor",
      below_average: "Below Average",
      average: "Average",
      good: "Good",
      excellent: "Excellent",
    };
    summaryParts.push("");
    summaryParts.push(`**AI Performance:** ${ratingLabel[ap.rating] || ap.rating}`);
    if (ap.strengths.length > 0) {
      summaryParts.push(...ap.strengths.map((s) => `- (+) ${s}`));
    }
    if (ap.weaknesses.length > 0) {
      summaryParts.push(...ap.weaknesses.map((s) => `- (-) ${s}`));
    }
  }

  // Friction points
  if (feedback.frictionPoints && feedback.frictionPoints.length > 0) {
    summaryParts.push("");
    summaryParts.push("**Friction Points**");
    for (const fp of feedback.frictionPoints) {
      summaryParts.push(`- Turn ${fp.turn}: \`${fp.type}\` — ${fp.description}`);
    }
  }

  summaryParts.push("");
  summaryParts.push("**Strengths**");
  summaryParts.push(...feedback.strengths.map((s) => `- ${s}`));
  summaryParts.push("");
  summaryParts.push("**Areas for Improvement**");
  summaryParts.push(...feedback.improvements.map((s) => `- ${s}`));

  const summaryBody = summaryParts.join("\n");

  annotations.push({
    id: randomUUID(),
    sceneIndex: 0,
    body: summaryBody,
    author: "vibe-feedback",
    createdAt: now,
    updatedAt: now,
    resolved: false,
  });

  // Per-prompt feedback
  for (const item of feedback.feedbackItems) {
    const categoryLabel: Record<string, string> = {
      clarity: "Clarity",
      specificity: "Specificity",
      context: "Context",
      efficiency: "Efficiency",
      iteration: "Iteration",
      "tool-usage": "Tool Usage",
    };
    const label = categoryLabel[item.category] || item.category;

    let body = `**${item.title}** \`${label}\`\n\n${item.feedback}`;
    if (item.improvedPrompt) {
      body += `\n\n**Suggested prompt:**\n> ${item.improvedPrompt.replace(/\n/g, "\n> ")}`;
    }

    annotations.push({
      id: randomUUID(),
      sceneIndex: item.sceneIndex,
      body,
      author: "vibe-feedback",
      createdAt: now,
      updatedAt: now,
      resolved: false,
    });
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/** Generate AI feedback for a replay session. */
export async function generateFeedback(
  session: ReplaySession,
  selection: AiSelection,
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ annotations: Annotation[]; result: FeedbackResult } | null> {
  if (session.meta.stats.userPrompts === 0) {
    return null;
  }

  const digest = buildSessionDigest(session);
  const prompt = buildFeedbackPrompt(digest, session);

  const output = await executeFeedback(
    prompt,
    selection,
    createResultTool("submit_feedback", FEEDBACK_RESULT_SCHEMA),
    signal,
  );

  const result = parseFeedbackResponse(output, session);

  if (!result || result.feedbackItems.length === 0) {
    return null;
  }

  return { annotations: feedbackToAnnotations(result), result };
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function collectTranslatableScenes(scenes: Scene[]): Array<{ index: number; content: string }> {
  return scenes
    .map((s, i) =>
      s.type === "user-prompt" || s.type === "text-response"
        ? { index: i, content: s.content }
        : null,
    )
    .filter((s): s is { index: number; content: string } => s !== null);
}

function buildTranslationPrompt(
  session: ReplaySession,
  opts: { targetLang: string; sourceLang?: string },
): { prompt: string; translatableScenes: Array<{ index: number; content: string }> } {
  const translatableScenes = collectTranslatableScenes(session.scenes);

  const scenesBlock = translatableScenes
    .map((s) => `--- SCENE ${s.index} ---\n${s.content}`)
    .join("\n\n");

  const sourcePart = opts.sourceLang ? `from ${opts.sourceLang} ` : "";

  const prompt = `You are a translation assistant for AI coding sessions. Translate the following conversation messages (user prompts and assistant responses) ${sourcePart}to ${opts.targetLang}.

## Rules
- Only translate natural language text
- Preserve code blocks, file paths, variable names, CLI commands, and technical identifiers verbatim
- Preserve markdown formatting
- Keep widely-used technical jargon in their original form (API, endpoint, middleware, etc.)
- Maintain the original intent and tone
- If a message is already entirely in ${opts.targetLang}, return it unchanged with "unchanged": true

## Messages to Translate

${scenesBlock}

## Required Output
Call the provided submit_translation tool exactly once with the complete result.
Do not emit a prose answer outside that tool call.

Schema:
{
  "translations": [
    {
      "sceneIndex": <number>,
      "translated": "<string: the translated text>",
      "unchanged": <boolean: true if message was already in target language>
    }
  ]
}

CRITICAL RULES:
- Do not use filesystem, network, or MCP tools
- Call submit_translation exactly once; do not output prose outside the tool call
- You MUST include an entry for every scene index: [${translatableScenes.map((s) => s.index).join(", ")}]
- Preserve all code blocks and inline code exactly as-is`;

  return { prompt, translatableScenes };
}

interface TranslationResult {
  overlays: SceneOverlay[];
  stats: { translated: number; skipped: number };
}

interface OverlayBatchResult {
  overlays: SceneOverlay[];
  skipped: number;
}

function aggregateOverlayBatches(
  batchResults: Array<OverlayBatchResult | null>,
): OverlayBatchResult | null {
  if (batchResults.some((result) => result === null)) return null;

  const overlays: SceneOverlay[] = [];
  let skipped = 0;
  for (const result of batchResults) {
    if (!result) return null;
    overlays.push(...result.overlays);
    skipped += result.skipped;
  }

  if (overlays.length === 0 && skipped === 0) return null;
  return { overlays, skipped };
}

/** Max scenes per batch to avoid LLM output truncation */
const TRANSLATE_BATCH_SIZE = 30;
/** Avoid overwhelming local gateways when a session spans many batches. */
const AI_STUDIO_BATCH_CONCURRENCY = 2;

async function runAiStudioBatches<T, R>(
  batches: readonly T[],
  worker: (batch: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const batchController = new AbortController();
  const batchSignal = signal
    ? AbortSignal.any([signal, batchController.signal])
    : batchController.signal;
  const results: R[] = [];
  let nextIndex = 0;
  let firstError: unknown;

  const runWorker = async () => {
    while (true) {
      batchSignal.throwIfAborted();
      const index = nextIndex++;
      if (index >= batches.length) return;
      try {
        results[index] = await worker(batches[index], batchSignal);
      } catch (error) {
        firstError ??= error;
        batchController.abort(error);
        throw error;
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(AI_STUDIO_BATCH_CONCURRENCY, batches.length) }, () =>
        runWorker(),
      ),
    );
  } catch (error) {
    throw firstError ?? error;
  }

  return results;
}

/**
 * Parse a single batch of translation output into overlays.
 * Returns overlays + skip count for this batch.
 */
function parseTranslationBatch(
  output: string,
  batchScenes: Array<{ index: number; content: string }>,
  opts: { sourceLang?: string; targetLang: string },
  now: string,
): { overlays: SceneOverlay[]; skipped: number } | null {
  const json = extractJson(output);
  if (!json) return null;

  const parsed = parseJsonObject(json);
  if (!parsed || !Array.isArray(parsed.translations)) return null;

  const validIndices = new Set(batchScenes.map((s) => s.index));
  const overlays: SceneOverlay[] = [];
  let skipped = 0;

  for (const rawItem of parsed.translations) {
    const item = asRecord(rawItem);
    if (!item || typeof item.sceneIndex !== "number") continue;
    if (!validIndices.has(item.sceneIndex)) continue;
    if (typeof item.translated !== "string") continue;
    const translated = item.translated;

    const scene = batchScenes.find((s) => s.index === item.sceneIndex);
    if (!scene) continue;

    if (item.unchanged || translated.trim() === scene.content.trim()) {
      skipped++;
      continue;
    }

    const source: OverlaySource = {
      type: "translate",
      params: { from: opts.sourceLang || "auto", to: opts.targetLang },
    };

    overlays.push({
      id: randomUUID(),
      sceneIndex: item.sceneIndex,
      field: "content",
      originalValue: scene.content,
      modifiedValue: translated,
      source,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { overlays, skipped };
}

export async function generateTranslation(
  session: ReplaySession,
  selection: AiSelection,
  opts: { targetLang: string; sourceLang?: string },
  execution: { signal?: AbortSignal } = {},
): Promise<TranslationResult | null> {
  if (session.scenes.length === 0) return null;

  // Collect all translatable scenes
  const allScenes = collectTranslatableScenes(session.scenes);

  if (allScenes.length === 0) return null;

  // Split into batches to avoid LLM output truncation
  const batches: Array<{ index: number; content: string }>[] = [];
  for (let i = 0; i < allScenes.length; i += TRANSLATE_BATCH_SIZE) {
    batches.push(allScenes.slice(i, i + TRANSLATE_BATCH_SIZE));
  }

  const now = new Date().toISOString();

  const batchResults = await runAiStudioBatches(
    batches,
    async (batch, signal) => {
      const { prompt } = buildTranslationPrompt(
        { ...session, scenes: rebuildScenesForBatch(session.scenes, batch) },
        opts,
      );
      const output = await executeFeedback(
        prompt,
        selection,
        createResultTool("submit_translation", TRANSLATION_RESULT_SCHEMA),
        signal,
      );
      return parseTranslationBatch(output, batch, opts, now);
    },
    execution.signal,
  );

  const aggregate = aggregateOverlayBatches(batchResults);
  if (!aggregate) return null;
  return {
    overlays: aggregate.overlays,
    stats: { translated: aggregate.overlays.length, skipped: aggregate.skipped },
  };
}

/**
 * Create a sparse scenes array that only contains the batch scenes at their
 * original indices, so buildTranslationPrompt emits the correct scene indices.
 */
function rebuildScenesForBatch(
  originalScenes: ReplaySession["scenes"],
  batch: Array<{ index: number; content: string }>,
): ReplaySession["scenes"] {
  const batchIndices = new Set(batch.map((b) => b.index));
  return originalScenes.map((scene, i) => {
    if (batchIndices.has(i)) return scene;
    // Replace non-batch scenes with a type that buildTranslationPrompt will skip
    return { type: "tool-call" as const, toolName: "", input: {}, result: "" };
  });
}

// ---------------------------------------------------------------------------
// Tone Adjustment
// ---------------------------------------------------------------------------

function buildTonePrompt(
  session: ReplaySession,
  opts: { style: "professional" | "neutral" | "friendly" },
): { prompt: string; userPromptScenes: Array<{ index: number; content: string }> } {
  const userPromptScenes = session.scenes
    .map((s, i) => (s.type === "user-prompt" ? { index: i, content: s.content } : null))
    .filter((s): s is { index: number; content: string } => s !== null);

  const scenesBlock = userPromptScenes
    .map((s) => `--- SCENE ${s.index} ---\n${s.content}`)
    .join("\n\n");

  const styleGuide: Record<string, string> = {
    professional:
      "Direct but respectful, suitable for work sharing. Remove frustration and harshness while keeping clarity.",
    neutral: "Factual and unemotional, like technical documentation. Strip all emotional language.",
    friendly: "Warm and collaborative, like messaging a teammate. Keep it casual but constructive.",
  };

  const prompt = `You are a tone adjustment assistant for AI coding sessions. Rewrite the following user prompts to be more ${opts.style}.

## Style Guide: ${opts.style}
${styleGuide[opts.style]}

## Rules
- Preserve the EXACT technical meaning and intent of each prompt
- Remove frustration, harsh language, profanity, or passive-aggressive tone
- Keep code references, file paths, and technical terms unchanged
- If a prompt's tone is already appropriate, return it unchanged with "unchanged": true
- Do NOT add excessive politeness or corporate-speak — keep it natural
- Preserve code blocks and markdown formatting

## User Prompts to Adjust

${scenesBlock}

## Required Output
Call the provided submit_tone_adjustments tool exactly once with the complete result.
Do not emit a prose answer outside that tool call.

Schema:
{
  "adjustments": [
    {
      "sceneIndex": <number>,
      "adjusted": "<string: the tone-adjusted text>",
      "unchanged": <boolean: true if prompt tone was already appropriate>
    }
  ]
}

CRITICAL RULES:
- Do not use filesystem, network, or MCP tools
- Call submit_tone_adjustments exactly once; do not output prose outside the tool call
- You MUST include an entry for every scene index: [${userPromptScenes.map((s) => s.index).join(", ")}]
- Preserve all code blocks and inline code exactly as-is`;

  return { prompt, userPromptScenes };
}

interface ToneResult {
  overlays: SceneOverlay[];
  stats: { adjusted: number; skipped: number };
}

/** Max scenes per batch to avoid LLM output truncation */
const TONE_BATCH_SIZE = 30;

/**
 * Parse a single batch of tone adjustment output into overlays.
 */
function parseToneBatch(
  output: string,
  batchScenes: Array<{ index: number; content: string }>,
  opts: { style: "professional" | "neutral" | "friendly" },
  now: string,
): { overlays: SceneOverlay[]; skipped: number } | null {
  const json = extractJson(output);
  if (!json) return null;

  const parsed = parseJsonObject(json);
  if (!parsed || !Array.isArray(parsed.adjustments)) return null;

  const validIndices = new Set(batchScenes.map((s) => s.index));
  const overlays: SceneOverlay[] = [];
  let skipped = 0;

  for (const rawItem of parsed.adjustments) {
    const item = asRecord(rawItem);
    if (!item || typeof item.sceneIndex !== "number") continue;
    if (!validIndices.has(item.sceneIndex)) continue;
    if (typeof item.adjusted !== "string") continue;
    const adjusted = item.adjusted;

    const scene = batchScenes.find((s) => s.index === item.sceneIndex);
    if (!scene) continue;

    if (item.unchanged || adjusted.trim() === scene.content.trim()) {
      skipped++;
      continue;
    }

    const source: OverlaySource = {
      type: "tone",
      params: { style: opts.style },
    };

    overlays.push({
      id: randomUUID(),
      sceneIndex: item.sceneIndex,
      field: "content",
      originalValue: scene.content,
      modifiedValue: adjusted,
      source,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { overlays, skipped };
}

/**
 * Create a sparse scenes array for tone batching (only user-prompt scenes in batch).
 */
function rebuildScenesForToneBatch(
  originalScenes: ReplaySession["scenes"],
  batch: Array<{ index: number; content: string }>,
): ReplaySession["scenes"] {
  const batchIndices = new Set(batch.map((b) => b.index));
  return originalScenes.map((scene, i) => {
    if (batchIndices.has(i)) return scene;
    return { type: "tool-call" as const, toolName: "", input: {}, result: "" };
  });
}

export async function generateToneAdjustment(
  session: ReplaySession,
  selection: AiSelection,
  opts: { style: "professional" | "neutral" | "friendly" },
  execution: { signal?: AbortSignal } = {},
): Promise<ToneResult | null> {
  if (session.meta.stats.userPrompts === 0) return null;

  // Collect all user-prompt scenes
  const allScenes = session.scenes
    .map((s, i) => (s.type === "user-prompt" ? { index: i, content: s.content } : null))
    .filter((s): s is { index: number; content: string } => s !== null);

  if (allScenes.length === 0) return null;

  // Split into batches to avoid LLM output truncation
  const batches: Array<{ index: number; content: string }>[] = [];
  for (let i = 0; i < allScenes.length; i += TONE_BATCH_SIZE) {
    batches.push(allScenes.slice(i, i + TONE_BATCH_SIZE));
  }

  const now = new Date().toISOString();

  const batchResults = await runAiStudioBatches(
    batches,
    async (batch, signal) => {
      const { prompt } = buildTonePrompt(
        { ...session, scenes: rebuildScenesForToneBatch(session.scenes, batch) },
        opts,
      );
      const output = await executeFeedback(
        prompt,
        selection,
        createResultTool("submit_tone_adjustments", TONE_RESULT_SCHEMA),
        signal,
      );
      return parseToneBatch(output, batch, opts, now);
    },
    execution.signal,
  );

  const aggregate = aggregateOverlayBatches(batchResults);
  if (!aggregate) return null;
  return {
    overlays: aggregate.overlays,
    stats: { adjusted: aggregate.overlays.length, skipped: aggregate.skipped },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const __testables = { aggregateOverlayBatches };
