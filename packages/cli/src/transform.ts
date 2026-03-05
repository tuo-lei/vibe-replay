import { homedir } from "node:os";
import type { Scene, ReplaySession } from "./types.js";
import type { ProviderParseResult } from "./providers/types.js";

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
): ReplaySession {
  const scenes: Scene[] = [];
  let userPrompts = 0;
  let toolCalls = 0;

  for (const turn of parsed.turns) {
    if (turn.role === "user") {
      const textBlocks = turn.blocks.filter((b) => b.type === "text");
      const content = textBlocks.map((b) => (b as any).text || "").join("\n");
      // Collect user-pasted images
      const imageBlock = turn.blocks.find((b) => (b as any).type === "_user_images") as any;
      const images: string[] | undefined = imageBlock?.images;
      if (content.trim() || (images && images.length > 0)) {
        scenes.push({
          type: "user-prompt",
          content: content.trim() ? content : "(image)",
          timestamp: turn.timestamp,
          ...(images && images.length > 0 ? { images } : {}),
        });
        userPrompts++;
      }
      continue;
    }

    for (const block of turn.blocks) {
      if (block.type === "thinking") {
        const thinking = (block as any).thinking || "";
        if (thinking.trim()) {
          scenes.push({ type: "thinking", content: truncate(thinking, 2000), timestamp: turn.timestamp });
        }
      } else if (block.type === "text") {
        const text = (block as any).text || "";
        if (text.trim()) {
          scenes.push({ type: "text-response", content: text, timestamp: turn.timestamp });
        }
      } else if (block.type === "tool_use") {
        const toolBlock = block as any;
        const scene = buildToolScene(toolBlock.name, toolBlock.input || {}, toolBlock._result || "", toolBlock._images);
        (scene as any).timestamp = turn.timestamp;
        scenes.push(scene);
        toolCalls++;
      }
    }
  }

  return {
    meta: {
      sessionId: parsed.sessionId,
      slug: parsed.slug,
      title: parsed.title,
      provider,
      startTime: parsed.startTime || new Date().toISOString(),
      endTime: parsed.endTime,
      model: parsed.model,
      cwd: redactPath(parsed.cwd),
      project,
      stats: {
        sceneCount: scenes.length,
        userPrompts,
        toolCalls,
        durationMs: parsed.totalDurationMs,
      },
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
    result: truncate(result, 5000),
    ...(images && images.length > 0 ? { images } : {}),
  };

  if (toolName === "Edit" && input.file_path && input.old_string !== undefined) {
    (scene as any).diff = {
      filePath: redactPath(input.file_path),
      oldContent: input.old_string || "",
      newContent: input.new_string || "",
    };
  } else if (toolName === "Write" && input.file_path) {
    (scene as any).diff = {
      filePath: redactPath(input.file_path),
      oldContent: "",
      newContent: truncate(input.content || "", 3000),
    };
  } else if (toolName === "Bash" && input.command) {
    (scene as any).bashOutput = {
      command: redactPath(input.command),
      stdout: truncate(redactPath(result), 3000),
    };
  }

  return scene;
}

function sanitizeInput(input: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 3000) {
      sanitized[key] = redactSecrets(value.slice(0, 3000) + `\n... (${value.length} chars total)`);
    } else if (typeof value === "string") {
      sanitized[key] = redactSecrets(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((v) =>
        typeof v === "string" ? redactSecrets(v) :
        v && typeof v === "object" ? sanitizeInput(v) : v
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
  if (s.length <= max) return redactSecrets(s);
  return redactSecrets(s.slice(0, max) + `\n... (truncated, ${s.length} chars total)`);
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
  /((?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)[_A-Z]*\s*[=:]\s*["']?)[^\s"'\n]{8,}/gi,
  // npm tokens
  /npm_[a-zA-Z0-9]{36,}/g,
  // PEM private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  // Database connection strings with credentials
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^:]+:[^@]+@[^\s"']+/gi,
];

function redactSecrets(s: string): string {
  let result = s;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // For the env var pattern, preserve the key name
      const eqIdx = match.search(/[=:]/);
      if (eqIdx > 0) {
        return match.slice(0, eqIdx + 1) + " [REDACTED]";
      }
      return match.slice(0, 6) + "..." + "[REDACTED]";
    });
  }
  return result;
}
