import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiProviderInfo } from "../src/ai-runtime.js";
import { __testables } from "../src/server.js";

let piAgentDir: string;
let previousPiAgentDir: string | undefined;

function provider(
  id: string,
  modelId: string,
  baseUrl?: string,
  configured = true,
): AiProviderInfo {
  return {
    id,
    name: id,
    configured,
    authMethods: [],
    ...(baseUrl ? { custom: { baseUrl } } : {}),
    models: [
      {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
      },
    ],
  };
}

async function writePiDefault(providerId: string, modelId: string, baseUrl?: string) {
  await writeFile(
    join(piAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: providerId, defaultModel: modelId }),
  );
  if (baseUrl) {
    await writeFile(
      join(piAgentDir, "models.json"),
      JSON.stringify({ providers: { [providerId]: { baseUrl } } }),
    );
  }
}

beforeEach(async () => {
  piAgentDir = await mkdtemp(join(tmpdir(), "vibe-replay-pi-default-"));
  previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
});

afterEach(async () => {
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  await rm(piAgentDir, { recursive: true, force: true });
});

describe("AI default selection", () => {
  it("maps a Pi custom provider by endpoint identity, not by provider name", async () => {
    await writePiDefault("pi-gateway", "luna", "http://gateway.example/v1");

    const selection = await __testables.resolveDefaultAiSelection([
      provider("my-custom-provider", "luna", "http://gateway.example/v1/"),
      provider("other-provider", "luna", "http://other.example/v1"),
    ]);

    expect(selection).toEqual({ providerId: "my-custom-provider", modelId: "luna" });
  });

  it("does not select a same-named model from a different provider", async () => {
    await writePiDefault("pi-gateway", "luna", "http://gateway.example/v1");

    const selection = await __testables.resolveDefaultAiSelection([
      provider("wrong-provider", "luna", "http://other.example/v1"),
    ]);

    expect(selection).toBeUndefined();
  });

  it("does not choose the first provider when Pi has no matching default", async () => {
    const selection = await __testables.resolveDefaultAiSelection([
      provider("first-provider", "first-model"),
      provider("second-provider", "second-model"),
    ]);

    expect(selection).toBeUndefined();
  });
});
