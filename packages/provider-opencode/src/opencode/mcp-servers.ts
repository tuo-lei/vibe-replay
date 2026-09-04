import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

/**
 * opencode records MCP tool calls with a single flattened name:
 * `${sanitize(server)}_${sanitize(tool)}` where sanitize replaces any character
 * outside [a-zA-Z0-9_-] with "_". The stored part carries no separate server
 * field, so attribution has to come from the configured server names: the
 * longest sanitized server prefix followed by "_" wins. Mirrors opencode's
 * `McpCatalog.toolName`/`sanitize` (packages/opencode/src/mcp/catalog.ts).
 */
export function sanitizeOpencodeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Split an opencode tool name into its configured MCP server and tool. */
export function attributeOpencodeMcpTool(
  toolName: string,
  serverNames: readonly string[],
): { server: string; tool: string } | undefined {
  let best: { server: string; tool: string; prefixLength: number } | undefined;
  for (const server of serverNames) {
    const prefix = `${sanitizeOpencodeMcpName(server)}_`;
    if (!toolName.startsWith(prefix)) continue;
    const tool = toolName.slice(prefix.length);
    if (!tool) continue;
    if (!best || prefix.length > best.prefixLength) {
      best = { server, tool, prefixLength: prefix.length };
    }
  }
  return best ? { server: best.server, tool: best.tool } : undefined;
}

/**
 * Read the MCP server names from opencode's config files: the global
 * `~/.config/opencode/opencode.json[c]`, an explicit `OPENCODE_CONFIG`, and the
 * session directory's `opencode.json[c]`. Missing or malformed files are
 * ignored — MCP attribution is best-effort enrichment, never parse-blocking.
 */
export function loadOpencodeMcpServerNames(cwd?: string): string[] {
  return loadOpencodeMcpServerNamesFromConfigs(opencodeMcpConfigPaths(cwd));
}

/** Candidate opencode config files in precedence order (missing files skipped). */
export function opencodeMcpConfigPaths(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  const globalDir = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
  candidates.push(join(globalDir, "opencode.json"), join(globalDir, "opencode.jsonc"));
  if (env.OPENCODE_CONFIG) candidates.push(env.OPENCODE_CONFIG);
  if (cwd) {
    const dir = normalize(cwd);
    candidates.push(join(dir, "opencode.json"), join(dir, "opencode.jsonc"));
  }
  return candidates;
}

/** Merge `mcp` server keys from the given config files, deduplicated. */
export function loadOpencodeMcpServerNamesFromConfigs(configPaths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const file of configPaths) {
    for (const name of readMcpServerNames(file)) names.add(name);
  }
  return [...names];
}

function readMcpServerNames(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = parseJsonc(raw) as { mcp?: unknown };
    const mcp = parsed?.mcp;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return [];
    return Object.keys(mcp).filter((name) => name.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * opencode configs allow JSONC (comments + trailing commas). Parse with
 * JSON.parse first, then retry after stripping comments and trailing commas
 * with a small string-aware scanner.
 */
function parseJsonc(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripJsonc(raw));
  }
}

function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (next !== undefined) out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (
      ch === "," &&
      (() => {
        let j = i + 1;
        while (j < raw.length && /\s/.test(raw[j]!)) j++;
        return raw[j] === "}" || raw[j] === "]";
      })()
    ) {
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
