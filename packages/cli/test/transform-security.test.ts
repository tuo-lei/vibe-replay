import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { transformToReplay } from "../src/transform.js";
import type { ProviderParseResult } from "../src/providers/types.js";
import type { ReplaySession } from "../src/types.js";

const HOME = homedir();
const EXAMPLE_OPENAI_KEY = ["sk", "proj", "abc123def456ghi789jkl012mno345pqr678"].join("-");
const EXAMPLE_GH_PAT = ["ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijkl"].join("");
const EXAMPLE_AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const EXAMPLE_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
].join(".");
const EXAMPLE_PEM = [
  ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
  "MIIEow...",
  ["-----END ", "RSA PRIVATE KEY-----"].join(""),
].join("\n");
const EXAMPLE_DB_URI = [
  "postgres://",
  "admin",
  ":",
  "supersecret",
  "@",
  "db.example.com:5432/mydb",
].join("");
const EXAMPLE_ENV_KEY = ["sk", "1234567890abcdef"].join("");
const EXAMPLE_VAULT_TOKEN = ["hvs.", "CAESIJmOp9YjD5K8bN3XhRGdL1r2vwZkXyz7aBcDeFgHiJk"].join("");

/** Build a minimal ProviderParseResult with given turns. */
function makeParsed(
  turns: ProviderParseResult["turns"],
  overrides?: Partial<ProviderParseResult>,
): ProviderParseResult {
  return {
    sessionId: "test-session",
    slug: "test",
    cwd: "/safe/path",
    turns,
    ...overrides,
  };
}

function transform(parsed: ProviderParseResult): ReplaySession {
  return transformToReplay(parsed, "test-provider", "~/test");
}

// ---------------------------------------------------------------------------
// redactPath — replaces home directory with ~
// ---------------------------------------------------------------------------

describe("path redaction", () => {
  it("redacts home dir in user prompt content", () => {
    const parsed = makeParsed([
      { role: "user", blocks: [{ type: "text", text: `Look at ${HOME}/secret/project` }] },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "user-prompt")!;
    expect(scene.content).not.toContain(HOME);
    expect(scene.content).toContain("~/secret/project");
  });

  it("redacts home dir in text response content", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [{ type: "text", text: `Found file at ${HOME}/code/app.ts` }],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).not.toContain(HOME);
    expect(scene.content).toContain("~/code/app.ts");
  });

  it("redacts home dir in thinking content", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [{ type: "thinking", thinking: `Reading ${HOME}/data/config.json` } as any],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "thinking")!;
    expect(scene.content).not.toContain(HOME);
    expect(scene.content).toContain("~/data/config.json");
  });

  it("redacts home dir in tool call result", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/safe/path" },
            _result: `Content of ${HOME}/private/file.ts`,
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.result).not.toContain(HOME);
    expect(scene.result).toContain("~/private/file.ts");
  });

  it("redacts home dir in tool input values via sanitizeInput", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: `${HOME}/project/src/index.ts` },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.input!.file_path).not.toContain(HOME);
    expect(scene.input!.file_path).toContain("~/project/src/index.ts");
  });

  it("redacts home dir in Bash command", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: `cat ${HOME}/secrets/env` },
            _result: "FOO=bar",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.command).not.toContain(HOME);
    expect(scene.bashOutput!.command).toContain("~/secrets/env");
  });

  it("redacts home dir in Bash stdout", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "pwd" },
            _result: `${HOME}/my-project`,
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.stdout).not.toContain(HOME);
    expect(scene.bashOutput!.stdout).toContain("~/my-project");
  });

  it("redacts home dir in Edit diff filePath", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Edit",
            input: {
              file_path: `${HOME}/project/auth.ts`,
              old_string: "broken()",
              new_string: "fixed()",
            },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.diff!.filePath).not.toContain(HOME);
    expect(scene.diff!.filePath).toContain("~/project/auth.ts");
  });

  it("redacts home dir in Write diff filePath", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: {
              file_path: `${HOME}/project/new-file.ts`,
              content: "export const x = 1;",
            },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.diff!.filePath).not.toContain(HOME);
    expect(scene.diff!.filePath).toContain("~/project/new-file.ts");
  });

  it("redacts home dir in cwd metadata", () => {
    const parsed = makeParsed([], { cwd: `${HOME}/my-workspace` });
    const replay = transform(parsed);
    expect(replay.meta.cwd).not.toContain(HOME);
    expect(replay.meta.cwd).toBe("~/my-workspace");
  });

  it("redacts multiple home dir occurrences in one string", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          { type: "text", text: `cp ${HOME}/a.txt ${HOME}/b.txt` },
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).toBe("cp ~/a.txt ~/b.txt");
  });
});

// ---------------------------------------------------------------------------
// redactSecrets — API keys, tokens, emails, etc.
// ---------------------------------------------------------------------------

describe("secret redaction in transform", () => {
  it("redacts OpenAI key in user prompt", () => {
    const key = EXAMPLE_OPENAI_KEY;
    const parsed = makeParsed([
      { role: "user", blocks: [{ type: "text", text: `Use key ${key}` }] },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "user-prompt")!;
    expect(scene.content).not.toContain(key);
    expect(scene.content).toContain("[REDACTED]");
  });

  it("redacts GitHub PAT in text response", () => {
    const token = EXAMPLE_GH_PAT;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [{ type: "text", text: `Token is ${token}` }],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).not.toContain(token);
    expect(scene.content).toContain("[REDACTED]");
  });

  it("redacts AWS access key in tool result", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "env" },
            _result: `AWS_ACCESS_KEY_ID=${EXAMPLE_AWS_KEY}\nAWS_SECRET=foo`,
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.result).not.toContain(EXAMPLE_AWS_KEY);
    expect(scene.result).toContain("[REDACTED]");
  });

  it("redacts JWT in tool input", () => {
    const jwt = EXAMPLE_JWT;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: `curl -H "Authorization: Bearer ${jwt}" http://api.example.com` },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.command).not.toContain(jwt);
    expect(scene.bashOutput!.command).toContain("[REDACTED]");
  });

  it("redacts PEM private key in text response", () => {
    const pem = EXAMPLE_PEM;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [{ type: "text", text: `Here's the key:\n${pem}` }],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).not.toContain("MIIEow");
    expect(scene.content).toContain("[REDACTED]");
  });

  it("redacts database connection string", () => {
    const uri = EXAMPLE_DB_URI;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [{ type: "text", text: `Connect to ${uri}` }],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).not.toContain("supersecret");
    expect(scene.content).toContain("[REDACTED]");
  });

  it("redacts env var secret pattern", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "cat .env" },
            _result: `API_KEY=${EXAMPLE_ENV_KEY}\nSECRET_TOKEN="myverylongsecretvalue"`,
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.stdout).not.toContain(EXAMPLE_ENV_KEY);
    expect(scene.bashOutput!.stdout).not.toContain("myverylongsecretvalue");
    expect(scene.bashOutput!.stdout).toContain("[REDACTED]");
  });

  it("redacts Vault token in thinking block", () => {
    const token = EXAMPLE_VAULT_TOKEN;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [{ type: "thinking", thinking: `The vault token is ${token}` } as any],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "thinking")!;
    expect(scene.content).not.toContain(token);
    expect(scene.content).toContain("[REDACTED]");
  });

  it("redacts secrets inside nested tool input objects", () => {
    const key = EXAMPLE_GH_PAT;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "SomeApi",
            input: { headers: { authorization: key } },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(JSON.stringify(scene.input)).not.toContain(key);
    expect(JSON.stringify(scene.input)).toContain("[REDACTED]");
  });

  it("redacts secrets inside tool input arrays", () => {
    const token = EXAMPLE_GH_PAT;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Multi",
            input: { tokens: [token, "safe-value"] },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(JSON.stringify(scene.input)).not.toContain(token);
    expect(scene.input!.tokens[1]).toBe("safe-value");
  });
});

// ---------------------------------------------------------------------------
// Email redaction
// ---------------------------------------------------------------------------

describe("email redaction", () => {
  it("redacts email in user prompt, preserving domain", () => {
    const parsed = makeParsed([
      { role: "user", blocks: [{ type: "text", text: "Email me at alice@example.com" }] },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "user-prompt")!;
    expect(scene.content).not.toContain("alice@");
    expect(scene.content).toContain("[REDACTED]@example.com");
  });

  it("redacts email in text response", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Author: dev@company.io" }],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).not.toContain("dev@");
    expect(scene.content).toContain("[REDACTED]@company.io");
  });

  it("redacts email with + addressing (GitHub noreply)", () => {
    const email = "45369003+user@users.noreply.github.com";
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: `git commit --author="Name <${email}>"` },
            _result: "committed",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.command).not.toContain("45369003+user@");
    expect(scene.bashOutput!.command).toContain("[REDACTED]@users.noreply.github.com");
  });

  it("redacts email in tool result (git log output)", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "git log -1" },
            _result: "Author: Jane Doe <jane@corp.com>\nCommitter: Jane Doe <jane@corp.com>",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.stdout).not.toContain("jane@");
    expect(scene.bashOutput!.stdout).toContain("[REDACTED]@corp.com");
  });

  it("redacts multiple emails in a single string", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "CC: alice@example.com, bob@example.org" },
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).not.toContain("alice@");
    expect(scene.content).not.toContain("bob@");
    expect(scene.content).toContain("[REDACTED]@example.com");
    expect(scene.content).toContain("[REDACTED]@example.org");
  });

  it("redacts email in tool input string values", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: {
              file_path: "/config.yaml",
              content: "admin_email: admin@internal.net",
            },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.input!.content).not.toContain("admin@");
    expect(scene.input!.content).toContain("[REDACTED]@internal.net");
  });
});

// ---------------------------------------------------------------------------
// sanitizeInput — truncation + deep redaction
// ---------------------------------------------------------------------------

describe("sanitizeInput", () => {
  it("truncates long string values in tool input", () => {
    const longStr = "A".repeat(5000);
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "/big.txt", content: longStr },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.input!.content.length).toBeLessThan(longStr.length);
    expect(scene.input!.content).toContain("chars total");
  });

  it("preserves non-string values in tool input", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Config",
            input: { count: 42, enabled: true, label: "safe" },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.input!.count).toBe(42);
    expect(scene.input!.enabled).toBe(true);
    expect(scene.input!.label).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// truncate + redactSecrets on tool result
// ---------------------------------------------------------------------------

describe("tool result truncation", () => {
  it("truncates long tool results", () => {
    const longResult = "X".repeat(10000);
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "cat bigfile" },
            _result: longResult,
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.result!.length).toBeLessThan(longResult.length);
    expect(scene.result).toContain("truncated");
  });

  it("redacts secrets in truncated result", () => {
    const prefix = "A".repeat(4900);
    const secretTail = EXAMPLE_GH_PAT;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/f" },
            _result: prefix + secretTail,
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.result).not.toContain(secretTail);
  });
});

// ---------------------------------------------------------------------------
// Combined: path + secret in same string
// ---------------------------------------------------------------------------

describe("combined path + secret redaction", () => {
  it("redacts both home dir and API key in bash command", () => {
    const key = EXAMPLE_OPENAI_KEY;
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: `OPENAI_KEY=${key} node ${HOME}/app/run.js` },
            _result: "done",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.command).not.toContain(HOME);
    expect(scene.bashOutput!.command).not.toContain(key);
    expect(scene.bashOutput!.command).toContain("~/app/run.js");
    expect(scene.bashOutput!.command).toContain("[REDACTED]");
  });

  it("redacts both home dir and email in git output", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "git log" },
            _result: `commit abc123\nAuthor: User <user@corp.com>\n${HOME}/project/file.ts`,
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "tool-call")!;
    expect(scene.bashOutput!.stdout).not.toContain(HOME);
    expect(scene.bashOutput!.stdout).not.toContain("user@");
    expect(scene.bashOutput!.stdout).toContain("~/project/file.ts");
    expect(scene.bashOutput!.stdout).toContain("[REDACTED]@corp.com");
  });
});

// ---------------------------------------------------------------------------
// Tool diff generation edge cases
// ---------------------------------------------------------------------------

describe("tool diff generation", () => {
  it("creates Edit diff even when old_string is missing", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "t1",
            name: "Edit",
            input: {
              file_path: "/project/src/app.ts",
              new_string: "console.log('updated')",
            },
            _result: "ok",
          } as any,
        ],
      },
    ]);
    const replay = transform(parsed);
    const toolScene = replay.scenes.find((s) => s.type === "tool-call") as any;
    expect(toolScene?.diff).toBeTruthy();
    expect(toolScene.diff.filePath).toBe("/project/src/app.ts");
    expect(toolScene.diff.oldContent).toBe("");
    expect(toolScene.diff.newContent).toContain("updated");
  });
});

describe("replay generator metadata", () => {
  it("includes generator info when provided", () => {
    const parsed = makeParsed([
      { role: "user", blocks: [{ type: "text", text: "hello" }] },
    ]);
    const replay = transformToReplay(parsed, "test-provider", "~/test", {
      generator: {
        name: "vibe-replay",
        version: "0.0.4",
        generatedAt: "2026-03-07T00:00:00.000Z",
      },
    });
    expect(replay.meta.generator).toEqual({
      name: "vibe-replay",
      version: "0.0.4",
      generatedAt: "2026-03-07T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("redaction edge cases", () => {
  it("does not crash on empty content", () => {
    const parsed = makeParsed([
      { role: "user", blocks: [{ type: "text", text: "" }] },
      { role: "assistant", blocks: [{ type: "text", text: "" }] },
      { role: "assistant", blocks: [{ type: "thinking", thinking: "" } as any] },
    ]);
    const replay = transform(parsed);
    expect(replay.scenes.length).toBe(0);
  });

  it("does not redact safe strings that look similar to patterns", () => {
    const parsed = makeParsed([
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Run sk-command in the terminal" },
        ],
      },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "text-response")!;
    expect(scene.content).toBe("Run sk-command in the terminal");
  });

  it("handles strings with only home dir path", () => {
    const parsed = makeParsed([
      { role: "user", blocks: [{ type: "text", text: HOME }] },
    ]);
    const replay = transform(parsed);
    const scene = replay.scenes.find((s) => s.type === "user-prompt")!;
    expect(scene.content).toBe("~");
  });
});
