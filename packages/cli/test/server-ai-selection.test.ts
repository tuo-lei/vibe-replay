import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as aiRuntime from "../src/ai-runtime.js";
import type { AiProviderInfo } from "../src/ai-runtime.js";
import { __testables } from "../src/server.js";

let settingsPath: string;
let previousSettingsPath: string | undefined;

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

async function writeAppDefault(providerId: string, modelId: string) {
  await writeFile(settingsPath, JSON.stringify({ providerId, modelId }));
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-replay-ai-default-"));
  settingsPath = join(root, "ai-settings.json");
  previousSettingsPath = process.env.VIBE_REPLAY_AI_SETTINGS;
  process.env.VIBE_REPLAY_AI_SETTINGS = settingsPath;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousSettingsPath === undefined) delete process.env.VIBE_REPLAY_AI_SETTINGS;
  else process.env.VIBE_REPLAY_AI_SETTINGS = previousSettingsPath;
  await rm(settingsPath, { force: true });
  await rm(join(settingsPath, ".."), { recursive: true, force: true });
});

describe("AI default selection", () => {
  it("reads the app-owned default without consulting Pi settings", async () => {
    await writeAppDefault("my-custom-provider", "luna");

    const selection = await __testables.resolveDefaultAiSelection([
      provider("my-custom-provider", "luna"),
      provider("other-provider", "luna"),
    ]);

    expect(selection).toEqual({ providerId: "my-custom-provider", modelId: "luna" });
  });

  it("prefers Luna on the custom endpoint when no app default exists", async () => {
    const selection = await __testables.resolveDefaultAiSelection([
      provider("openai", "gpt-5.6-luna"),
      provider("custom-openai", "gpt-5.6-luna"),
    ]);

    expect(selection).toEqual({ providerId: "custom-openai", modelId: "gpt-5.6-luna" });
  });

  it("does not choose the first provider when Luna is unavailable", async () => {
    const selection = await __testables.resolveDefaultAiSelection([
      provider("first-provider", "first-model"),
      provider("second-provider", "second-model"),
    ]);

    expect(selection).toBeUndefined();
  });

  it.each([
    { providerId: "removed-provider", modelId: "removed-model" },
    { providerId: "openai", modelId: "removed-model" },
    { providerId: "unconfigured-provider", modelId: "gpt-5.6-luna" },
    { providerId: "empty-provider", modelId: "removed-model" },
  ])("replaces the unusable saved default $providerId/$modelId with Luna", async (saved) => {
    await writeAppDefault(saved.providerId, saved.modelId);
    const emptyProvider = provider("empty-provider", "removed-model");
    emptyProvider.models = [];

    const selection = await __testables.resolveDefaultAiSelection([
      provider("openai", "gpt-5.6-luna"),
      provider("unconfigured-provider", "gpt-5.6-luna", undefined, false),
      emptyProvider,
    ]);

    expect(selection).toEqual({ providerId: "openai", modelId: "gpt-5.6-luna" });
    expect(await aiRuntime.readAiDefaultSelection()).toEqual(selection);
  });

  it.each([false, true])(
    "preserves a concurrent valid explicit choice (stale: %s)",
    async (stale) => {
      if (stale) await writeAppDefault("openai", "removed-model");
      const readDefault = aiRuntime.readAiDefaultSelection;
      vi.spyOn(aiRuntime, "readAiDefaultSelection").mockImplementationOnce(async () => {
        const observed = await readDefault();
        await aiRuntime.writeAiDefaultSelection({
          providerId: "explicit",
          modelId: "chosen-model",
        });
        return observed;
      });

      const selection = await __testables.resolveDefaultAiSelection([
        provider("openai", "gpt-5.6-luna"),
        provider("explicit", "chosen-model"),
      ]);

      expect(selection).toEqual({ providerId: "explicit", modelId: "chosen-model" });
      expect(await readDefault()).toEqual(selection);
    },
  );

  it("does not return or overwrite a different unusable concurrent choice", async () => {
    await writeAppDefault("openai", "removed-model");
    const readDefault = aiRuntime.readAiDefaultSelection;
    vi.spyOn(aiRuntime, "readAiDefaultSelection").mockImplementationOnce(async () => {
      const observed = await readDefault();
      await aiRuntime.writeAiDefaultSelection({ providerId: "new-provider", modelId: "new-model" });
      return observed;
    });

    const selection = await __testables.resolveDefaultAiSelection([
      provider("openai", "gpt-5.6-luna"),
    ]);

    expect(selection).toEqual({ providerId: "openai", modelId: "gpt-5.6-luna" });
    expect(await readDefault()).toEqual({ providerId: "new-provider", modelId: "new-model" });
  });
});
