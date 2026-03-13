/**
 * vibe-feedback: AI-powered prompting feedback for coding sessions.
 *
 * Detects available AI CLI tools (claude, agent, opencode) and runs them headlessly
 * to analyze a replay session and generate structured feedback on the user's
 * prompting technique. Feedback is returned as Annotation[] that merges
 * directly into the replay.
 *
 * Experimental feature — output quality depends on the model behind the CLI.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Annotation, OverlaySource, ReplaySession, SceneOverlay } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedbackTool {
  name: "claude" | "agent" | "opencode";
  command: string;
}

export interface FeedbackItem {
  sceneIndex: number;
  title: string;
  feedback: string;
  category: "clarity" | "specificity" | "context" | "efficiency" | "iteration" | "tool-usage";
  improvedPrompt?: string;
}

export interface FeedbackResult {
  summary: string;
  score: number;
  strengths: string[];
  improvements: string[];
  feedbackItems: FeedbackItem[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const TOOL_PRIORITY: FeedbackTool["name"][] = ["claude", "agent", "opencode"];

/** Detect available AI CLI tools and pick a default by priority. */
export async function detectFeedbackTools(): Promise<{
  tools: FeedbackTool[];
  defaultTool: FeedbackTool | null;
}> {
  // Skip claude when running inside a Claude Code session (nested sessions crash)
  const insideClaude = !!process.env.CLAUDECODE;

  const candidates: { name: FeedbackTool["name"]; cmd: string }[] = [
    ...(!insideClaude ? [{ name: "claude" as const, cmd: "claude" }] : []),
    { name: "agent" as const, cmd: "agent" },
    { name: "opencode" as const, cmd: "opencode" },
  ];

  const tools: FeedbackTool[] = [];
  for (const tool of candidates) {
    try {
      const path = await shell(`which ${tool.cmd}`);
      if (path.trim()) tools.push({ name: tool.name, command: path.trim() });
    } catch {
      /* not found */
    }
  }

  const defaultTool =
    TOOL_PRIORITY.map((name) => tools.find((t) => t.name === name)).find(
      (tool): tool is FeedbackTool => !!tool,
    ) || null;

  return { tools, defaultTool };
}

// ---------------------------------------------------------------------------
// Session digest — condense session for AI consumption
// ---------------------------------------------------------------------------

function buildSessionDigest(session: ReplaySession): string {
  const lines: string[] = [];
  const promptCount = session.meta.stats.userPrompts;

  // Adaptive truncation budgets based on number of prompts
  const maxPromptChars = Math.min(3000, Math.floor(25000 / Math.max(promptCount, 1)));
  const maxResponseChars = Math.min(800, Math.floor(12000 / Math.max(promptCount, 1)));

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
      } else if (scene.bashOutput) {
        const cmd =
          scene.bashOutput.command.length > 120
            ? `${scene.bashOutput.command.slice(0, 120)}...`
            : scene.bashOutput.command;
        turnLines.push(`  - Bash: ${cmd}`);
      } else {
        const input = JSON.stringify(scene.input).slice(0, 100);
        turnLines.push(`  - ${scene.toolName}: ${input}`);
      }
    } else if (scene.type === "compaction-summary") {
      turnLines.push("  - [Context compaction — earlier context was summarized]");
    }
  }
  flush();

  // Hard cap for safety (roughly 30KB ≈ ~7500 tokens)
  const digest = lines.join("\n");
  if (digest.length > 35000) {
    return `${digest.slice(0, 35000)}\n\n... (remaining turns omitted due to length)`;
  }
  return digest;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const FEEDBACK_SCHEMA = `{
  "summary": "<string: 2-3 paragraph overall assessment>",
  "score": <number 1-10>,
  "strengths": ["<string>", ...],
  "improvements": ["<string>", ...],
  "feedbackItems": [
    {
      "sceneIndex": <number: must be a user-prompt scene index from the transcript>,
      "title": "<string: short descriptive title>",
      "feedback": "<string: detailed actionable feedback>",
      "category": "<clarity|specificity|context|efficiency|iteration|tool-usage>",
      "improvedPrompt": "<string|null: optional rewritten prompt>"
    }
  ]
}`;

const FEEDBACK_EXAMPLE = `{
  "summary": "The user demonstrates good instincts for task decomposition, breaking complex work into manageable steps. However, several prompts lack specificity — the AI had to spend extra turns searching for context that could have been provided upfront. The strongest prompts came later in the session after the user learned what information the AI needed.",
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

  return `You are an expert AI coding coach. Analyze this recorded AI coding session and provide detailed, constructive feedback on the user's prompting technique.

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

## Analysis Guidelines
For each user prompt, consider:
1. **Clarity** — Was it unambiguous? Could the AI misinterpret?
2. **Specificity** — Enough detail, file paths, constraints?
3. **Context** — Did the user explain what they're trying to achieve?
4. **Efficiency** — Could fewer or better prompts achieve the same result?
5. **Iteration** — When things went wrong, how well did the user course-correct?
6. **Tool-usage** — Did the user leverage the AI's capabilities (search, test, etc.)?

## Required Output
Respond with ONLY a valid JSON object. No markdown code fences. No explanation before or after.

Schema:
${FEEDBACK_SCHEMA}

Example (for reference only — analyze the ACTUAL session above):
${FEEDBACK_EXAMPLE}

CRITICAL RULES:
- DO NOT use any tools, file reads, or web searches. Analyze ONLY the transcript above.
- Output ONLY the JSON object — no other text
- sceneIndex MUST be one of: [${userPromptIndices.join(", ")}]
- Provide feedback for the most impactful prompts (at least ${Math.min(userPromptIndices.length, 3)}, up to ${Math.min(userPromptIndices.length, 10)})
- score: 1 = very poor, 5 = average, 8 = strong, 10 = expert
- Be constructive and encouraging, but honest
- improvedPrompt is optional — only when you have a concretely better version
- Think step by step about each prompt in context before judging it`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executeFeedback(prompt: string, tool: FeedbackTool): Promise<string> {
  if (tool.name === "claude") {
    return runClaude(prompt, tool.command);
  }
  if (tool.name === "agent") {
    return runAgent(prompt, tool.command);
  }
  return runOpencode(prompt, tool.command);
}

function runClaude(prompt: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, ["-p", "--output-format", "json"], {
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 600_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed.result || stdout);
        } catch {
          resolve(stdout);
        }
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => reject(new Error(`Failed to start claude: ${err.message}`)));

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function runOpencode(prompt: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use stdin pipe: opencode reads from stdin when run without message args
    const proc = spawn(cmd, ["run"], {
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      timeout: 600_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stripAnsi(stdout));
      } else {
        reject(new Error(`opencode exited ${code}: ${stripAnsi(stderr).slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => reject(new Error(`Failed to start opencode: ${err.message}`)));

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function runAgent(prompt: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, ["-p", "--output-format", "json", "--mode", "ask", "--trust"], {
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 600_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          resolve(typeof parsed.result === "string" ? parsed.result : stdout);
        } catch {
          resolve(stdout);
        }
      } else {
        reject(new Error(`agent exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => reject(new Error(`Failed to start agent: ${err.message}`)));

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

function parseFeedbackResponse(output: string, session: ReplaySession): FeedbackResult | null {
  const json = extractJson(output);
  if (!json) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  // Validate top-level shape
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.summary !== "string" || !parsed.summary) return null;
  if (typeof parsed.score !== "number") return null;
  parsed.score = Math.max(1, Math.min(10, Math.round(parsed.score)));
  if (!Array.isArray(parsed.strengths)) parsed.strengths = [];
  if (!Array.isArray(parsed.improvements)) parsed.improvements = [];
  if (!Array.isArray(parsed.feedbackItems)) parsed.feedbackItems = [];

  // Valid user-prompt scene indices
  const validIndices = new Set(
    session.scenes.map((s, i) => (s.type === "user-prompt" ? i : -1)).filter((i) => i !== -1),
  );
  const validCategories = new Set([
    "clarity",
    "specificity",
    "context",
    "efficiency",
    "iteration",
    "tool-usage",
  ]);

  const items: FeedbackItem[] = [];
  for (const raw of parsed.feedbackItems) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.sceneIndex !== "number") continue;
    if (!validIndices.has(raw.sceneIndex)) continue;
    if (typeof raw.title !== "string" || !raw.title) continue;
    if (typeof raw.feedback !== "string" || !raw.feedback) continue;

    items.push({
      sceneIndex: raw.sceneIndex,
      title: raw.title,
      feedback: raw.feedback,
      category: validCategories.has(raw.category) ? raw.category : "clarity",
      improvedPrompt:
        typeof raw.improvedPrompt === "string" && raw.improvedPrompt
          ? raw.improvedPrompt
          : undefined,
    });
  }

  return {
    summary: parsed.summary,
    score: parsed.score,
    strengths: parsed.strengths.filter((s: any) => typeof s === "string"),
    improvements: parsed.improvements.filter((s: any) => typeof s === "string"),
    feedbackItems: items,
  };
}

/** Best-effort JSON extraction from potentially noisy output. */
function extractJson(raw: string): string | null {
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

function findBalancedJson(str: string): string | null {
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
function repairTruncatedJson(str: string): string | null {
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

function feedbackToAnnotations(feedback: FeedbackResult): Annotation[] {
  const now = new Date().toISOString();
  const annotations: Annotation[] = [];

  // Overall summary (attached to first scene)
  const summaryBody = [
    `## Prompting Score: ${feedback.score}/10\n`,
    feedback.summary,
    "",
    "**Strengths**",
    ...feedback.strengths.map((s) => `- ${s}`),
    "",
    "**Areas for Improvement**",
    ...feedback.improvements.map((s) => `- ${s}`),
  ].join("\n");

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

/**
 * Generate AI feedback for a replay session.
 * Returns annotations + parsed result, or null on failure.
 * Set debug=true to write raw output to /tmp for troubleshooting.
 */
export async function generateFeedback(
  session: ReplaySession,
  tool: FeedbackTool,
  { debug = false }: { debug?: boolean } = {},
): Promise<{ annotations: Annotation[]; result: FeedbackResult } | null> {
  if (session.meta.stats.userPrompts === 0) {
    return null;
  }

  const digest = buildSessionDigest(session);
  const prompt = buildFeedbackPrompt(digest, session);

  if (debug) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/vibe-feedback-prompt.txt", prompt);
  }

  const output = await executeFeedback(prompt, tool);

  if (debug) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/vibe-feedback-raw-output.txt", output);
  }

  const result = parseFeedbackResponse(output, session);

  if (!result || result.feedbackItems.length === 0) {
    return null;
  }

  return { annotations: feedbackToAnnotations(result), result };
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function buildTranslationPrompt(
  session: ReplaySession,
  opts: { targetLang: string; sourceLang?: string },
): { prompt: string; translatableScenes: Array<{ index: number; content: string }> } {
  const translatableScenes = session.scenes
    .map((s, i) =>
      s.type === "user-prompt" || s.type === "text-response"
        ? { index: i, content: s.content }
        : null,
    )
    .filter((s): s is { index: number; content: string } => s !== null);

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
Respond with ONLY a valid JSON object. No markdown code fences. No explanation before or after.

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
- DO NOT use any tools, file reads, or web searches
- Output ONLY the JSON object — no other text
- You MUST include an entry for every scene index: [${translatableScenes.map((s) => s.index).join(", ")}]
- Preserve all code blocks and inline code exactly as-is`;

  return { prompt, translatableScenes };
}

interface TranslationResult {
  overlays: SceneOverlay[];
  stats: { translated: number; skipped: number };
}

export async function generateTranslation(
  session: ReplaySession,
  tool: FeedbackTool,
  opts: { targetLang: string; sourceLang?: string },
): Promise<TranslationResult | null> {
  if (session.scenes.length === 0) return null;

  const { prompt, translatableScenes } = buildTranslationPrompt(session, opts);
  const output = await executeFeedback(prompt, tool);
  const json = extractJson(output);
  if (!json) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.translations)) return null;

  const now = new Date().toISOString();
  const validIndices = new Set(translatableScenes.map((s) => s.index));
  const overlays: SceneOverlay[] = [];
  let skipped = 0;

  for (const item of parsed.translations) {
    if (!item || typeof item.sceneIndex !== "number") continue;
    if (!validIndices.has(item.sceneIndex)) continue;
    if (typeof item.translated !== "string") continue;

    const scene = translatableScenes.find((s) => s.index === item.sceneIndex);
    if (!scene) continue;

    if (item.unchanged || item.translated.trim() === scene.content.trim()) {
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
      modifiedValue: item.translated,
      source,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { overlays, stats: { translated: overlays.length, skipped } };
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
Respond with ONLY a valid JSON object. No markdown code fences. No explanation before or after.

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
- DO NOT use any tools, file reads, or web searches
- Output ONLY the JSON object — no other text
- You MUST include an entry for every scene index: [${userPromptScenes.map((s) => s.index).join(", ")}]
- Preserve all code blocks and inline code exactly as-is`;

  return { prompt, userPromptScenes };
}

interface ToneResult {
  overlays: SceneOverlay[];
  stats: { adjusted: number; skipped: number };
}

export async function generateToneAdjustment(
  session: ReplaySession,
  tool: FeedbackTool,
  opts: { style: "professional" | "neutral" | "friendly" },
): Promise<ToneResult | null> {
  if (session.meta.stats.userPrompts === 0) return null;

  const { prompt, userPromptScenes } = buildTonePrompt(session, opts);
  const output = await executeFeedback(prompt, tool);
  const json = extractJson(output);
  if (!json) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.adjustments)) return null;

  const now = new Date().toISOString();
  const validIndices = new Set(userPromptScenes.map((s) => s.index));
  const overlays: SceneOverlay[] = [];
  let skipped = 0;

  for (const item of parsed.adjustments) {
    if (!item || typeof item.sceneIndex !== "number") continue;
    if (!validIndices.has(item.sceneIndex)) continue;
    if (typeof item.adjusted !== "string") continue;

    const scene = userPromptScenes.find((s) => s.index === item.sceneIndex);
    if (!scene) continue;

    if (item.unchanged || item.adjusted.trim() === scene.content.trim()) {
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
      modifiedValue: item.adjusted,
      source,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { overlays, stats: { adjusted: overlays.length, skipped } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

function shell(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", cmd], { timeout: 5000 });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed`));
    });
    proc.on("error", reject);
  });
}
