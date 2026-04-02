/** Parse MCP tool name: "mcp__server__tool" → { server, tool } or null */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** Display-friendly tool name: "mcp__chrome__navigate" → "chrome · navigate" */
export function displayToolName(name: string): string {
  const mcp = parseMcpName(name);
  if (mcp) return `${mcp.server} · ${mcp.tool}`;
  return name;
}
