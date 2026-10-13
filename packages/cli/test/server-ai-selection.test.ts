import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as aiRuntime from "../src/ai-runtime.js";
import type { AiProviderInfo } from "../src/ai-runtime.js";
import { __testables } from "../src/server.js";
import { registerAiRoutes } from "../src/server-routes/ai.js";
import { resolveAiSelection } from "../src/server-ai-selection.js";

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
  vi.spyOn(aiRuntime.getAiRuntime(), "listProviders").mockResolvedValue([]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousSettingsPath === undefined) delete process.env.VIBE_REPLAY_AI_SETTINGS;
  else process.env.VIBE_REPLAY_AI_SETTINGS = previousSettingsPath;
  await rm(settingsPath, { force: true });
  await rm(join(settingsPath, ".."), { recursive: true, force: true });
});

describe("AI default selection", () => {
  it.each([
    {
      name: "newly discovered provider",
      initial: [],
      refreshed: [provider("openai", "other-model")],
      expected: "No AI provider/model is selected. Choose a provider and model in AI Studio.",
    },
    {
      name: "removed last provider",
      initial: [provider("openai", "other-model")],
      refreshed: [],
      expected: "No usable AI provider is configured. Set up a provider and model in AI Studio.",
    },
  ])(
    "uses the refreshed catalog for the $name generation error",
    async ({ initial, refreshed, expected }) => {
      if (initial.length) await writeAppDefault("openai", "removed-model");
      vi.mocked(aiRuntime.getAiRuntime().listProviders)
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(refreshed);
      await expect(resolveAiSelection(undefined)).rejects.toThrow(expected);
      expect(aiRuntime.getAiRuntime().listProviders).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["providers", false],
    ["providers", true],
    ["generation", false],
    ["generation", true],
  ] as const)(
    "cancels %s default repair when refresh aborts (reject: %s)",
    async (flow, reject) => {
      await writeAppDefault("openai", "removed-model");
      const catalog = [provider("openai", "gpt-5.6-luna")];
      const controller = new AbortController();
      const reason = new DOMException("Synthetic disconnect", "AbortError");
      let refreshSignal: AbortSignal | undefined;
      vi.mocked(aiRuntime.getAiRuntime().listProviders)
        .mockResolvedValueOnce(catalog)
        .mockImplementationOnce(async (options) => {
          refreshSignal = options?.signal;
          controller.abort(reason);
          if (reject) throw reason;
          return catalog;
        });
      vi.spyOn(aiRuntime.getAiRuntime(), "getSafeErrorMessage").mockResolvedValue(
        "Request aborted",
      );
      const resolveModel = vi
        .spyOn(aiRuntime.getAiRuntime(), "resolveModel")
        .mockRejectedValue(new Error("Generation continued after abort"));
      const outcome =
        flow === "providers"
          ? await requestProviders(controller.signal)
          : await resolveAiSelection(undefined, controller.signal).catch((error: unknown) => error);
      expect(await aiRuntime.readAiDefaultSelection()).toEqual({
        providerId: "openai",
        modelId: "removed-model",
      });
      expect(refreshSignal?.aborted).toBe(true);
      if (flow === "providers") expect((outcome as Response).status).toBe(500);
      else expect(outcome).toBe(reason);
      expect(resolveModel).not.toHaveBeenCalled();
    },
  );

  it("propagates an abort from the settings repair instead of returning fallback", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic disconnect", "AbortError");
    const ensure = vi
      .spyOn(aiRuntime, "ensureAiDefaultSelection")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw reason;
      });
    await expect(
      __testables.resolveDefaultAiSelection(
        [provider("openai", "gpt-5.6-luna")],
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(ensure).toHaveBeenCalledWith(
      { providerId: "openai", modelId: "gpt-5.6-luna" },
      controller.signal,
      undefined,
    );
    expect(await aiRuntime.readAiDefaultSelection()).toBeUndefined();
  });

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

    const catalog = [
      provider("openai", "gpt-5.6-luna"),
      provider("unconfigured-provider", "gpt-5.6-luna", undefined, false),
      emptyProvider,
    ];
    vi.mocked(aiRuntime.getAiRuntime().listProviders).mockResolvedValue(catalog);
    const selection = await __testables.resolveDefaultAiSelection(catalog);

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

      const catalog = [provider("openai", "gpt-5.6-luna"), provider("explicit", "chosen-model")];
      vi.mocked(aiRuntime.getAiRuntime().listProviders).mockResolvedValue(catalog);
      const selection = await __testables.resolveDefaultAiSelection(catalog);

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

    const catalog = [provider("openai", "gpt-5.6-luna")];
    vi.mocked(aiRuntime.getAiRuntime().listProviders).mockResolvedValue(catalog);
    const selection = await __testables.resolveDefaultAiSelection(catalog);

    expect(selection).toEqual({ providerId: "openai", modelId: "gpt-5.6-luna" });
    expect(await readDefault()).toEqual({ providerId: "new-provider", modelId: "new-model" });
  });

  it.each(["openai", "new-provider"])("preserves a newly available choice on %s", async (id) => {
    await writeAppDefault("openai", "removed-model");
    const readDefault = aiRuntime.readAiDefaultSelection;
    vi.spyOn(aiRuntime, "readAiDefaultSelection").mockImplementationOnce(async () => {
      const observed = await readDefault();
      await aiRuntime.writeAiDefaultSelection({ providerId: id, modelId: "new-model" });
      return observed;
    });
    vi.mocked(aiRuntime.getAiRuntime().listProviders).mockResolvedValue([
      provider(id, "new-model"),
    ]);

    const selection = await __testables.resolveDefaultAiSelection([
      provider("openai", "gpt-5.6-luna"),
    ]);

    expect(selection).toEqual({ providerId: id, modelId: "new-model" });
    expect(await readDefault()).toEqual(selection);
  });

  it.each(
    ["openai", "new-provider"].flatMap((id) =>
      ["before", "after", "empty", "empty-stale", "no-luna"].map((timing) => ({ id, timing })),
    ),
  )("returns a coherent catalog for $id ($timing)", async ({ id, timing }) => {
    const beforeRead = timing === "before";
    if (timing !== "empty" && timing !== "no-luna") {
      await writeAppDefault(beforeRead ? id : "openai", beforeRead ? "new-model" : "removed-model");
    }
    const readDefault = aiRuntime.readAiDefaultSelection;
    vi.spyOn(aiRuntime, "readAiDefaultSelection").mockImplementationOnce(async () => {
      const observed = await readDefault();
      await aiRuntime.writeAiDefaultSelection({ providerId: id, modelId: "new-model" });
      return observed;
    });
    const refreshed = [provider(id, "new-model")];
    vi.mocked(aiRuntime.getAiRuntime().listProviders)
      .mockResolvedValueOnce(
        timing.startsWith("empty")
          ? []
          : [provider("openai", timing === "no-luna" ? "other-model" : "gpt-5.6-luna")],
      )
      .mockResolvedValue(refreshed);
    const app = new Hono();
    registerAiRoutes(app, {
      baseDir: "/synthetic",
      loadSession: vi.fn(),
      isSameOriginSettingsRequest: () => true,
    });

    const response = await app.request("/api/ai/providers");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      providers: refreshed,
      defaultProvider: { id, name: id, modelId: "new-model" },
    });
    expect(await readDefault()).toEqual({ providerId: id, modelId: "new-model" });
  });

  it.each(["gpt-5.6-luna", "other-model"])(
    "publishes first-time discovery of %s",
    async (modelId) => {
      const refreshed = [provider("openai", modelId)];
      vi.mocked(aiRuntime.getAiRuntime().listProviders)
        .mockResolvedValueOnce([])
        .mockResolvedValue(refreshed);
      const response = await requestProviders();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: true,
        providers: refreshed,
        defaultProvider:
          modelId === "gpt-5.6-luna" ? { id: "openai", name: "openai", modelId } : null,
      });
      expect(await aiRuntime.readAiDefaultSelection()).toEqual(
        modelId === "gpt-5.6-luna" ? { providerId: "openai", modelId } : undefined,
      );
    },
  );

  it.each([false, true])("does not seed a model removed by refresh (empty: %s)", async (empty) => {
    await writeAppDefault("openai", "removed-model");
    const refreshed = empty ? [] : [provider("openai", "other-model")];
    vi.mocked(aiRuntime.getAiRuntime().listProviders)
      .mockResolvedValueOnce([provider("openai", "gpt-5.6-luna")])
      .mockResolvedValue(refreshed);
    const response = await requestProviders();
    expect(await response.json()).toEqual({
      available: !empty,
      providers: refreshed,
      defaultProvider: null,
    });
    expect(await aiRuntime.readAiDefaultSelection()).toEqual({
      providerId: "openai",
      modelId: "removed-model",
    });
  });

  it("reuses a refreshed catalog when the invalid default has not changed", async () => {
    await writeAppDefault("openai", "removed-model");
    const catalog = [provider("openai", "other-model")];
    vi.mocked(aiRuntime.getAiRuntime().listProviders).mockResolvedValue(catalog);
    const response = await requestProviders();
    expect(await response.json()).toEqual({
      available: true,
      providers: catalog,
      defaultProvider: null,
    });
    expect(aiRuntime.getAiRuntime().listProviders).toHaveBeenCalledTimes(2);
  });

  it("does not refresh the caller's fresh catalog when no default is saved", async () => {
    const catalog = [provider("openai", "other-model")];
    vi.mocked(aiRuntime.getAiRuntime().listProviders).mockResolvedValue(catalog);
    const response = await requestProviders();
    expect(await response.json()).toEqual({
      available: true,
      providers: catalog,
      defaultProvider: null,
    });
    expect(aiRuntime.getAiRuntime().listProviders).toHaveBeenCalledTimes(1);
  });

  it("retains the known catalog when refresh fails", async () => {
    await writeAppDefault("openai", "removed-model");
    const catalog = [provider("openai", "gpt-5.6-luna")];
    vi.mocked(aiRuntime.getAiRuntime().listProviders)
      .mockResolvedValueOnce(catalog)
      .mockRejectedValue(new Error("synthetic discovery failure"));
    const response = await requestProviders();
    expect(await response.json()).toEqual({
      available: true,
      providers: catalog,
      defaultProvider: { id: "openai", name: "openai", modelId: "gpt-5.6-luna" },
    });
    expect(aiRuntime.getAiRuntime().listProviders).toHaveBeenCalledTimes(2);
  });

  it("preserves a same-valued explicit write under the settings lock", async () => {
    const explicit = { providerId: "openai", modelId: "restored-model" };
    await writeAppDefault(explicit.providerId, explicit.modelId);
    const observed = await aiRuntime.readAiDefaultSelection();
    await aiRuntime.writeAiDefaultSelection(explicit);
    const selected = await aiRuntime.ensureAiDefaultSelection(
      { providerId: "openai", modelId: "gpt-5.6-luna" },
      undefined,
      observed,
    );
    expect(selected).toEqual(explicit);
    expect(await aiRuntime.readAiDefaultSelection()).toEqual(explicit);
  });

  it("revalidates a same-valued choice whose model was concurrently restored", async () => {
    const explicit = { providerId: "openai", modelId: "restored-model" };
    await writeAppDefault(explicit.providerId, explicit.modelId);
    const readDefault = aiRuntime.readAiDefaultSelection;
    vi.spyOn(aiRuntime, "readAiDefaultSelection").mockImplementationOnce(async () => {
      const observed = await readDefault();
      await aiRuntime.writeAiDefaultSelection(explicit);
      return observed;
    });
    const initial = [provider("openai", "gpt-5.6-luna")];
    vi.mocked(aiRuntime.getAiRuntime().listProviders)
      .mockResolvedValueOnce(initial)
      .mockResolvedValue([provider("openai", "restored-model")]);
    const selected = await __testables.resolveDefaultAiSelection(initial);
    expect(selected).toEqual(explicit);
    expect(await readDefault()).toEqual(explicit);
  });
});

async function requestProviders(signal?: AbortSignal) {
  const app = new Hono();
  registerAiRoutes(app, {
    baseDir: "/synthetic",
    loadSession: vi.fn(),
    isSameOriginSettingsRequest: () => true,
  });
  return app.request("/api/ai/providers", { signal });
}
