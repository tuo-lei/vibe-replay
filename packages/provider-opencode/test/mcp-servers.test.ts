import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attributeOpencodeMcpTool,
  loadOpencodeMcpServerNamesFromConfigs,
  sanitizeOpencodeMcpName,
} from "../src/opencode/mcp-servers.js";

describe("opencode MCP server attribution", () => {
  it("sanitizes names like opencode's McpCatalog", () => {
    expect(sanitizeOpencodeMcpName("mcp-gateway-slack")).toBe("mcp-gateway-slack");
    expect(sanitizeOpencodeMcpName("my server")).toBe("my_server");
    expect(sanitizeOpencodeMcpName("weird.server/name")).toBe("weird_server_name");
  });

  it("splits tool names at the longest matching server prefix", () => {
    const servers = ["context7", "my_server_ext", "my_server"];
    expect(attributeOpencodeMcpTool("context7_query-docs", servers)).toEqual({
      server: "context7",
      tool: "query-docs",
    });
    expect(attributeOpencodeMcpTool("my_server_do_thing", servers)).toEqual({
      server: "my_server",
      tool: "do_thing",
    });
    expect(attributeOpencodeMcpTool("my_server_ext_do_thing", servers)).toEqual({
      server: "my_server_ext",
      tool: "do_thing",
    });
  });

  it("returns undefined for unconfigured or malformed names", () => {
    expect(attributeOpencodeMcpTool("grep", ["context7"])).toBeUndefined();
    expect(attributeOpencodeMcpTool("context7", ["context7"])).toBeUndefined();
    expect(attributeOpencodeMcpTool("context7_", ["context7"])).toBeUndefined();
    expect(attributeOpencodeMcpTool("else_tool", ["context7"])).toBeUndefined();
    expect(attributeOpencodeMcpTool("context7_tool", [])).toBeUndefined();
  });

  describe("config loading", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const freshDir = (): string => {
      const dir = mkdtempSync(join(tmpdir(), "opencode-mcp-config-"));
      dirs.push(dir);
      return dir;
    };

    it("reads server keys from JSON and JSONC configs, deduplicated", () => {
      const dir = freshDir();
      const jsonPath = join(dir, "opencode.json");
      const jsoncPath = join(dir, "opencode.jsonc");
      writeFileSync(jsonPath, JSON.stringify({ mcp: { alpha: { type: "local" } } }));
      writeFileSync(
        jsoncPath,
        `{
          // comment line
          "mcp": {
            "beta": { "type": "remote", "url": "https://x.test" }, /* inline */
            "alpha": { "type": "local" },
          },
        }`,
      );
      expect(loadOpencodeMcpServerNamesFromConfigs([jsonPath, jsoncPath]).sort()).toEqual([
        "alpha",
        "beta",
      ]);
    });

    it("ignores missing files, malformed configs, and non-object mcp sections", () => {
      const dir = freshDir();
      const bad = join(dir, "bad.json");
      const wrong = join(dir, "wrong.json");
      writeFileSync(bad, "{ not json at all");
      writeFileSync(wrong, JSON.stringify({ mcp: ["not", "an", "object"] }));
      expect(
        loadOpencodeMcpServerNamesFromConfigs([
          join(dir, "missing.json"),
          bad,
          wrong,
          join(dir, "still-missing.jsonc"),
        ]),
      ).toEqual([]);
    });
  });
});
