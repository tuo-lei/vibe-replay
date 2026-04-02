import { homedir } from "node:os";
import { estimateCost, estimateCostSimple, getModelContextLimit } from "./pricing.js";
import type { ProviderParseResult } from "./providers/types.js";
import type { ReplaySession, Scene, SubAgent } from "./types.js";

const HOME = homedir();

/** Replace absolute home dir path with ~ to avoid leaking username */
function redactPath(s: string): string {
  if (!HOME) return s;
  return s.replaceAll(HOME, "~");
}

export function transformToReplay(
  parsed: ProviderParseResult,
  provider: string,
  project: string,
  options?: {
    generator?: ReplaySession["meta"]["generator"];
  },
): ReplaySession {
  const scenes: Scene[] = [];
  let userPrompts = 0;
  let toolCalls = 0;
  let thinkingBlocks = 0;
  const syntheticSubAgentSummary: NonNullable<ReplaySession["meta"]["subAgentSummary"]> = [];

  for (const turn of parsed.turns) {
    if (turn.role === "user") {
      const textBlocks = turn.blocks.filter((b) => b.type === "text");
      const content = textBlocks.map((b) => (b as any).text || "").join("\n");
      const imageBlock = turn.blocks.find((b) => (b as any).type === "_user_images") as any;
      const images: string[] | undefined = imageBlock?.images;
      if (content.trim() || (images && images.length > 0)) {
        if (turn.subtype === "compaction-summary") {
          scenes.push({
            type: "compaction-summary",
            content: redactSecrets(redactPath(content)),
            timestamp: turn.timestamp,
          });
        } else if (turn.subtype === "context-injection") {
          scenes.push({
            type: "context-injection",
            content: redactSecrets(redactPath(content)),
            timestamp: turn.timestamp,
            injectionType: classifyInjection(content),
          });
        } else {
          scenes.push({
            type: "user-prompt",
            content: content.trim() ? redactSecrets(redactPath(content)) : "(image)",
            timestamp: turn.timestamp,
            ...(images && images.length > 0 ? { images } : {}),
          });
          userPrompts++;
        }
      }
      continue;
    }

    for (const block of turn.blocks) {
      if (block.type === "thinking") {
        const thinking = (block as any).thinking || "";
        if (thinking.trim()) {
          scenes.push({
            type: "thinking",
            content: truncate(redactPath(thinking), 2000),
            timestamp: turn.timestamp,
          });
          thinkingBlocks++;
        }
      } else if (block.type === "text") {
        const text = (block as any).text || "";
        if (text.trim()) {
          scenes.push({
            type: "text-response",
            content: redactSecrets(redactPath(text)),
            timestamp: turn.timestamp,
            ...(turn.stopReason === "max_tokens" ? { isTruncated: true as const } : {}),
          });
        }
      } else if (block.type === "tool_use") {
        const toolBlock = block as any;
        const scene = buildToolScene(
          toolBlock.name,
          toolBlock.input || {},
          toolBlock._result || "",
          toolBlock._images,
        );
        (scene as any).timestamp = turn.timestamp;
        (scene as any).isError = !!toolBlock._isError;
        if (toolBlock._durationMs) (scene as any).durationMs = toolBlock._durationMs;
        // Attach subagent data for Agent tool calls
        if (toolBlock.name === "Agent" && toolBlock._subAgent) {
          const sa = toolBlock._subAgent;
          (scene as any).subAgent = {
            agentId: sa.agentId,
            agentType: sa.agentType,
            description: sa.description,
            prompt: redactSecrets(redactPath(sa.prompt || "")),
            toolCalls: sa.toolCalls,
            thinkingBlocks: sa.thinkingBlocks,
            textResponses: sa.textResponses,
            tokenUsage: sa.tokenUsage,
            model: sa.model,
            scenes: (sa.scenes || []).map((s: any) => redactSubAgentScene(s)),
          } satisfies SubAgent;
        } else if (provider === "cursor" && toolBlock.name === "Agent") {
          const minimal = buildMinimalCursorSubAgent(toolBlock);
          if (minimal) {
            (scene as any).subAgent = minimal;
            syntheticSubAgentSummary.push({
              agentId: minimal.agentId,
              agentType: minimal.agentType,
              description: minimal.description,
              toolCalls: minimal.toolCalls,
              model: minimal.model,
            });
          }
        }
        scenes.push(scene);
        toolCalls++;
      }
    }
  }

  // Estimate cost based on per-model pricing (USD)
  let costEstimate: number | undefined;
  if (parsed.tokenUsageByModel) {
    costEstimate = estimateCost(parsed.tokenUsageByModel);
  } else if (parsed.tokenUsage) {
    // Empty string falls back to Sonnet rates via getModelPricing default
    costEstimate = estimateCostSimple(parsed.tokenUsage, parsed.model || "");
  }

  // Duration: parser now provides totalDurationMs from turn_duration events
  // or active-duration estimation — no wall-clock fallback needed.
  const durationMs =
    parsed.totalDurationMs && parsed.totalDurationMs > 0 ? parsed.totalDurationMs : undefined;

  return {
    meta: {
      sessionId: parsed.sessionId,
      slug: parsed.slug,
      title: parsed.title,
      provider,
      dataSource: parsed.dataSource,
      dataSourceInfo: parsed.dataSourceInfo,
      startTime: parsed.startTime || new Date().toISOString(),
      endTime: parsed.endTime,
      model: parsed.model,
      cwd: redactPath(parsed.cwd),
      project,
      ...(options?.generator ? { generator: options.generator } : {}),
      stats: {
        sceneCount: scenes.length,
        userPrompts,
        toolCalls,
        thinkingBlocks,
        durationMs,
        tokenUsage: parsed.tokenUsage,
        costEstimate,
        ...(parsed.turnStats ? { turnStats: parsed.turnStats } : {}),
      },
      ...(parsed.model ? { contextLimit: getModelContextLimit(parsed.model) } : {}),
      ...(parsed.tokenUsageByModel ? { tokenUsageByModel: parsed.tokenUsageByModel } : {}),
      ...(parsed.prLinks && parsed.prLinks.length > 0 ? { prLinks: parsed.prLinks } : {}),
      compactions: parsed.compactions,
      ...(parsed.subAgentSummary && parsed.subAgentSummary.length > 0
        ? { subAgentSummary: parsed.subAgentSummary }
        : syntheticSubAgentSummary.length > 0
          ? { subAgentSummary: syntheticSubAgentSummary }
          : {}),
      ...(parsed.gitBranch ? { gitBranch: parsed.gitBranch } : {}),
      ...(parsed.gitBranches ? { gitBranches: parsed.gitBranches } : {}),
      ...(parsed.entrypoint ? { entrypoint: parsed.entrypoint } : {}),
      ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
      ...(parsed.apiErrors && parsed.apiErrors.length > 0 ? { apiErrors: parsed.apiErrors } : {}),
      ...(parsed.trackedFiles && parsed.trackedFiles.length > 0
        ? { trackedFiles: parsed.trackedFiles.map(redactPath) }
        : {}),
      ...(parsed.contextFiles && parsed.contextFiles.length > 0
        ? { contextFiles: parsed.contextFiles.map(redactPath) }
        : {}),
      ...(parsed.cursorSidecars ? { cursorSidecars: parsed.cursorSidecars } : {}),
      ...(parsed.serviceTier ? { serviceTier: parsed.serviceTier } : {}),
      ...(parsed.skillsUsed ? { skillsUsed: parsed.skillsUsed } : {}),
      ...(parsed.mcpServersUsed ? { mcpServersUsed: parsed.mcpServersUsed } : {}),
      ...(parsed.truncatedResponses ? { truncatedResponses: parsed.truncatedResponses } : {}),
    },
    scenes,
  };
}

function buildToolScene(
  toolName: string,
  input: Record<string, any>,
  result: string,
  images?: string[],
): Scene {
  const scene: Scene = {
    type: "tool-call",
    toolName,
    input: sanitizeInput(input),
    result: truncate(redactPath(result), 5000),
    ...(images && images.length > 0 ? { images } : {}),
  };

  if (toolName === "Edit" && input.file_path) {
    (scene as any).diff = {
      filePath: redactPath(input.file_path),
      oldContent: input.old_string ?? "",
      newContent: input.new_string ?? "",
    };
  } else if (toolName === "Write" && input.file_path) {
    (scene as any).diff = {
      filePath: redactPath(input.file_path),
      oldContent: "",
      newContent: truncate(input.content || "", 3000),
    };
  } else if (toolName === "Delete" && input.file_path) {
    (scene as any).diff = {
      filePath: redactPath(input.file_path),
      oldContent: input.old_string ?? "(file deleted)",
      newContent: "",
    };
  } else if (toolName === "Bash" && input.command) {
    (scene as any).bashOutput = {
      command: redactSecrets(redactPath(input.command)),
      stdout: truncate(redactPath(result), 3000),
    };
  }

  return scene;
}

function sanitizeInput(input: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 3000) {
      sanitized[key] = redactSecrets(
        redactPath(`${value.slice(0, 3000)}\n... (${value.length} chars total)`),
      );
    } else if (typeof value === "string") {
      sanitized[key] = redactSecrets(redactPath(value));
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((v) =>
        typeof v === "string"
          ? redactSecrets(redactPath(v))
          : v && typeof v === "object"
            ? sanitizeInput(v)
            : v,
      );
    } else if (value && typeof value === "object") {
      sanitized[key] = sanitizeInput(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function truncate(s: string, max: number): string {
  const redacted = redactSecrets(s);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}\n... (truncated, ${redacted.length} chars total)`;
}

function buildMinimalCursorSubAgent(toolBlock: any): SubAgent | null {
  const input = toolBlock?.input;
  if (!input || typeof input !== "object") return null;
  const rawAgentType =
    typeof input.subagent_type === "string" && input.subagent_type.trim()
      ? input.subagent_type.trim()
      : undefined;
  if (!rawAgentType) return null;
  const agentType = normalizeCursorAgentType(rawAgentType);
  return {
    agentId:
      typeof toolBlock.id === "string" && toolBlock.id.trim()
        ? toolBlock.id
        : `cursor-agent-${agentType}`,
    agentType,
    ...(typeof input.description === "string" && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
    prompt: typeof input.prompt === "string" ? redactSecrets(redactPath(input.prompt)) : "",
    toolCalls: 0,
    thinkingBlocks: 0,
    textResponses: 0,
    model: typeof toolBlock.model === "string" ? toolBlock.model : undefined,
    scenes: [],
  };
}

function normalizeCursorAgentType(agentType: string): string {
  const normalized = agentType.trim().toLowerCase();
  if (normalized === "explore") return "Explore";
  if (normalized === "plan") return "Plan";
  if (normalized === "generalpurpose") return "general-purpose";
  if (normalized === "shell") return "Shell";
  return agentType;
}

/**
 * Classify isMeta injection by content pattern.
 * Returns a specific label like "skill:playwright-cli" or "command:/insights".
 */
function classifyInjection(content: string): string {
  if (content.startsWith("Base directory for this skill:")) {
    const skillPath = content.split("\n")[0].replace("Base directory for this skill: ", "").trim();
    const name = skillPath.split("/").pop() || "unknown";
    return `skill:${name}`;
  }
  if (content.startsWith("The user just ran /")) {
    const cmd = content.split("/")[1]?.split(/[\s\n]/)[0] || "unknown";
    return `command:/${cmd}`;
  }
  if (content.startsWith("Usage: /")) {
    const cmd = content.split("Usage: /")[1]?.split(/[\s\n]/)[0] || "unknown";
    return `command:/${cmd}`;
  }
  if (content.startsWith("[Image:")) return "image";
  if (content.startsWith("<local-command-caveat>")) return "local-command";
  return "system";
}

// Redact common secret patterns from output
const SECRET_PATTERNS = [
  // API keys (OpenAI, Anthropic)
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  // GitHub tokens
  /ghp_[a-zA-Z0-9]{36,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  // AWS
  /AKIA[A-Z0-9]{16}/g,
  // Google API keys
  /AIza[0-9A-Za-z_-]{35}/g,
  // Slack tokens
  /xox[bpsa]-[a-zA-Z0-9-]{10,}/g,
  // Stripe keys
  /[sr]k_live_[a-zA-Z0-9]{20,}/g,
  /pk_live_[a-zA-Z0-9]{20,}/g,
  // PyPI tokens
  /pypi-[a-zA-Z0-9_-]{50,}/g,
  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9_\-.]{20,}/g,
  // JWTs (three base64url segments separated by dots)
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  // SendGrid
  /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}/g,
  // Twilio
  /SK[0-9a-fA-F]{32}/g,
  // Mailgun
  /key-[a-zA-Z0-9]{32}/g,
  // Heroku (only when in heroku context — too broad to match all UUIDs)
  /(?:heroku[_-]?api[_-]?key|HEROKU_API_KEY)\s*[=:]\s*["']?[0-9a-f-]{36}/gi,
  // Age secret keys
  /AGE-SECRET-KEY-[A-Z0-9]{59}/g,
  // Hashicorp Vault tokens
  /hvs\.[a-zA-Z0-9_-]{24,}/g,
  // Generic env var patterns: KEY=value, SECRET=value, TOKEN=value, PASSWORD=value
  // (?![a-zA-Z]) prevents matching words like "Author:", "Secretary:", "Tokenize:" etc.
  /((?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)(?![a-zA-Z])[_A-Z]*\s*[=:]\s*["']?)[^\s"'\n]{8,}/gi,
  // npm tokens
  /npm_[a-zA-Z0-9]{36,}/g,
  // PEM private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  // Database connection strings with credentials
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^:]+:[^@]+@[^\s"']+/gi,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
];

function redactSubAgentScene(s: any): Scene {
  if (s.type === "tool-call") {
    const toolName = s.toolName || "";
    const input = s.input || {};
    const scene: Scene = {
      type: "tool-call",
      toolName,
      input: s.input ? sanitizeInput(s.input) : {},
      result: truncate(redactPath(s.result || ""), 1000),
      timestamp: s.timestamp,
      isError: s.isError || false,
    };

    // Preserve diff for file-modifying tools (same logic as buildToolScene)
    if (toolName === "Edit" && input.file_path) {
      (scene as any).diff = {
        filePath: redactPath(input.file_path),
        oldContent: input.old_string ?? "",
        newContent: input.new_string ?? "",
      };
    } else if (toolName === "Write" && input.file_path) {
      (scene as any).diff = {
        filePath: redactPath(input.file_path),
        oldContent: "",
        newContent: truncate(input.content || "", 3000),
      };
    } else if (toolName === "Delete" && input.file_path) {
      (scene as any).diff = {
        filePath: redactPath(input.file_path),
        oldContent: input.old_string ?? "(file deleted)",
        newContent: "",
      };
    }

    return scene;
  }
  return {
    type: s.type || "text-response",
    content: truncate(redactSecrets(redactPath(s.content || "")), 1000),
    timestamp: s.timestamp,
  } as Scene;
}

function redactSecrets(s: string): string {
  let result = s;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Email: keep domain for context
      if (match.includes("@") && /^[a-zA-Z0-9._%+-]+@/.test(match)) {
        const atIdx = match.indexOf("@");
        return `[REDACTED]${match.slice(atIdx)}`;
      }
      // Env var pattern: preserve the key name
      const eqIdx = match.search(/[=:]/);
      if (eqIdx > 0) {
        return `${match.slice(0, eqIdx + 1)} [REDACTED]`;
      }
      return `${match.slice(0, 6)}...[REDACTED]`;
    });
  }
  return result;
}
