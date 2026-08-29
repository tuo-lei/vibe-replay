import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAiRuntime,
  createBrowserAuthInteraction,
  FileCredentialStore,
  PiAiRuntime,
} from "../src/ai-runtime.js";

const temporaryRoots: string[] = [];
const POSIX_FILE_MODES = process.platform !== "win32";

const credentialWorkerSource = `
import { FileCredentialStore } from ${JSON.stringify(new URL("../src/ai-runtime.ts", import.meta.url).href)};

const authPath = process.env.VIBE_TEST_AUTH_PATH;
const mode = process.env.VIBE_TEST_AUTH_MODE;
if (!authPath || !mode) throw new Error("credential worker arguments are missing");

const store = new FileCredentialStore(authPath);
if (mode === "hold") {
  await store.modify("first", async () => {
    process.stdout.write("locked\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    return { type: "api_key", key: "first-key" };
  });
  process.exit(0);
}

if (mode === "write") {
  await store.modify("second", async () => ({ type: "api_key", key: "second-key" }));
  process.stdout.write("done\\n");
  process.exit(0);
}

if (mode === "crash") {
  await store.modify("crashed", async () => {
    await new Promise((resolve) => process.stdout.write("locked\\n", resolve));
    process.exit(23);
  });
}

throw new Error(\`unknown credential worker mode: \${mode}\`);
`;
const tsxLoaderUrl = new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

function startCredentialWorker(authPath: string, mode: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", tsxLoaderUrl, "--input-type=module", "--eval", credentialWorkerSource],
    {
      env: {
        ...process.env,
        VIBE_TEST_AUTH_PATH: authPath,
        VIBE_TEST_AUTH_MODE: mode,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function monitorCredentialWorker(child: ChildProcessWithoutNullStreams, expected: string) {
  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectExit!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    },
  );

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (!readySettled && stdout.includes(expected)) {
      readySettled = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    rejectExit(error);
  });
  child.once("exit", (code, signal) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(`credential worker exited before ${expected}: ${stdout}${stderr}`));
    }
    resolveExit({ code, signal });
  });

  return { ready, exited };
}

async function stopCredentialWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FileCredentialStore", () => {
  it("persists credentials atomically and lists only credential metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-auth-"));
    temporaryRoots.push(root);
    const path = join(root, "nested", "ai-auth.json");
    const store = new FileCredentialStore(path);

    await store.modify("openrouter", async () => ({
      type: "api_key",
      key: "secret-api-key",
    }));

    expect(await store.read("openrouter")).toEqual({
      type: "api_key",
      key: "secret-api-key",
    });
    expect(await store.list()).toEqual([{ providerId: "openrouter", type: "api_key" }]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "secret-api-key" },
    });
    if (POSIX_FILE_MODES) {
      expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent read-modify-write operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-auth-"));
    temporaryRoots.push(root);
    const store = new FileCredentialStore(join(root, "ai-auth.json"));

    await Promise.all([
      store.modify("openrouter", async () => ({ type: "api_key", key: "first" })),
      store.modify("openrouter", async () => ({ type: "api_key", key: "second" })),
    ]);

    const credential = await store.read("openrouter");
    expect(credential?.type).toBe("api_key");
    expect(["first", "second"]).toContain(credential && "key" in credential ? credential.key : "");
  });

  it("preserves updates from separate store instances sharing one file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-auth-"));
    temporaryRoots.push(root);
    const path = join(root, "ai-auth.json");
    const firstStore = new FileCredentialStore(path);
    const secondStore = new FileCredentialStore(path);
    let releaseFirst!: () => void;
    let firstOperation!: Promise<unknown>;
    const firstStarted = new Promise<void>((resolve) => {
      firstOperation = firstStore.modify("first", async () => {
        await new Promise<void>((resolveRelease) => {
          releaseFirst = resolveRelease;
          resolve();
        });
        return { type: "api_key", key: "first-key" };
      });
    });
    await firstStarted;

    const secondOperation = secondStore.modify("second", async () => ({
      type: "api_key",
      key: "second-key",
    }));
    releaseFirst();
    await Promise.all([firstOperation, secondOperation]);

    const verifier = new FileCredentialStore(path);
    expect((await verifier.read("first"))?.type).toBe("api_key");
    expect((await verifier.read("second"))?.type).toBe("api_key");
  });

  it("serializes mutations across credential-store processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-auth-"));
    temporaryRoots.push(root);
    const path = join(root, "ai-auth.json");
    const first = startCredentialWorker(path, "hold");
    const firstMonitor = monitorCredentialWorker(first, "locked");
    let second: ChildProcessWithoutNullStreams | undefined;
    try {
      await firstMonitor.ready;
      second = startCredentialWorker(path, "write");
      const secondMonitor = monitorCredentialWorker(second, "done");
      let secondExited = false;
      void secondMonitor.exited.then(() => {
        secondExited = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(secondExited).toBe(false);

      first.stdin.end("release\n");
      await expect(firstMonitor.exited).resolves.toMatchObject({ code: 0 });
      await expect(secondMonitor.ready).resolves.toBeUndefined();
      await expect(secondMonitor.exited).resolves.toMatchObject({ code: 0 });

      const verifier = new FileCredentialStore(path);
      expect((await verifier.read("first"))?.type).toBe("api_key");
      expect((await verifier.read("second"))?.type).toBe("api_key");
    } finally {
      first.stdin.destroy();
      await stopCredentialWorker(first);
      if (second) await stopCredentialWorker(second);
    }
  });

  it("recovers a lock left by a crashed credential-store process", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-auth-"));
    temporaryRoots.push(root);
    const path = join(root, "ai-auth.json");
    const crashed = startCredentialWorker(path, "crash");
    const monitor = monitorCredentialWorker(crashed, "locked");

    await monitor.ready;
    await expect(monitor.exited).resolves.toMatchObject({ code: 23 });

    const lockPath = `${path}.lock`;
    await expect(stat(lockPath)).resolves.toBeDefined();
    const staleTime = new Date(Date.now() - 2 * 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const recovered = new FileCredentialStore(path);
    await recovered.modify("after-crash", async () => ({
      type: "api_key",
      key: "recovered-key",
    }));

    expect((await recovered.read("after-crash"))?.type).toBe("api_key");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not persist a mutation cancelled before it reaches the write queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-auth-"));
    temporaryRoots.push(root);
    const store = new FileCredentialStore(join(root, "ai-auth.json"));
    let releaseFirst!: () => void;
    let firstOperation!: Promise<unknown>;
    const firstStarted = new Promise<void>((resolve) => {
      firstOperation = store.modify("first", async () => {
        await new Promise<void>((resolveRelease) => {
          releaseFirst = resolveRelease;
          resolve();
        });
        return { type: "api_key", key: "first-key" };
      });
    });
    await firstStarted;

    const controller = new AbortController();
    const queued = store.modify("second", async () => ({ type: "api_key", key: "second-key" }), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();
    await firstOperation;

    expect(await store.read("second")).toBeUndefined();
  });

  it("rejects an invalid credential file instead of silently falling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-auth-"));
    temporaryRoots.push(root);
    const path = join(root, "ai-auth.json");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "missing" } })),
    );

    await expect(new FileCredentialStore(path).read("openai")).rejects.toThrow(
      "Invalid AI credential for provider openai",
    );
  });
});

describe("PiAiRuntime", () => {
  it("registers the initial provider and authentication matrix", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const providers = await createAiRuntime({
      authPath: join(root, "ai-auth.json"),
      customConfigPath: join(root, "ai-providers.json"),
    }).listProviders();

    expect(providers.map((provider) => provider.id)).toEqual([
      "openai",
      "openai-codex",
      "openrouter",
      "opencode",
    ]);
    expect(providers.find((provider) => provider.id === "openai-codex")?.authMethods).toEqual([
      {
        type: "oauth",
        label: "OpenAI (ChatGPT Plus/Pro)",
        subscription: true,
      },
    ]);
    expect(providers.find((provider) => provider.id === "openrouter")?.authMethods).toEqual([
      { type: "api_key", label: "OpenRouter API key", subscription: false },
      { type: "oauth", label: "Sign in with OpenRouter", subscription: false },
    ]);
  });

  it("configures an OpenAI-compatible endpoint and discovers models from /models", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "proxy-model",
              name: "Proxy Model",
              context_length: 32_000,
              max_tokens: 4_096,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const runtime = createAiRuntime({
        authPath: join(root, "ai-auth.json"),
        customConfigPath: join(root, "ai-providers.json"),
      });

      await runtime.configureCustomProvider(
        { name: "Local LiteLLM", baseUrl: "http://127.0.0.1:58788" },
        "proxy-secret",
      );

      const custom = (await runtime.listProviders()).find(
        (provider) => provider.id === "custom-openai",
      );
      expect(custom).toMatchObject({
        id: "custom-openai",
        name: "Local LiteLLM",
        configured: true,
        authType: "api_key",
        authSource: "stored credential",
        custom: { baseUrl: "http://127.0.0.1:58788/v1" },
        models: [
          expect.objectContaining({
            id: "proxy-model",
            api: "openai-completions",
            input: ["text"],
          }),
        ],
      });
      expect(JSON.stringify(custom)).not.toContain("proxy-secret");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:58788/v1/models",
        expect.objectContaining({
          headers: {
            Accept: "application/json",
            Authorization: "Bearer proxy-secret",
          },
        }),
      );
      expect(JSON.parse(await readFile(join(root, "ai-providers.json"), "utf8"))).toEqual({
        customOpenAi: {
          name: "Local LiteLLM",
          baseUrl: "http://127.0.0.1:58788/v1",
        },
      });
      if (POSIX_FILE_MODES) {
        expect((await stat(join(root, "ai-providers.json"))).mode & 0o777).toBe(0o600);
      }
      expect((await runtime.credentials.read("custom-openai"))?.type).toBe("api_key");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not reuse a custom API key when the endpoint changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), authorization: headers.get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "proxy-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const runtime = createAiRuntime({
        authPath: join(root, "ai-auth.json"),
        customConfigPath: join(root, "ai-providers.json"),
      });

      await runtime.configureCustomProvider(
        { baseUrl: "https://old-gateway.example/v1" },
        "old-gateway-secret",
      );
      await runtime.configureCustomProvider({ baseUrl: "https://old-gateway.example/v1" });
      await runtime.configureCustomProvider({ baseUrl: "https://new-gateway.example/v1" });

      expect(requests).toEqual([
        {
          url: "https://old-gateway.example/v1/models",
          authorization: "Bearer old-gateway-secret",
        },
        {
          url: "https://old-gateway.example/v1/models",
          authorization: "Bearer old-gateway-secret",
        },
        {
          url: "https://new-gateway.example/v1/models",
          authorization: null,
        },
      ]);
      expect(await runtime.credentials.read("custom-openai")).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("serializes concurrent custom endpoint and key updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") });
      if (requests.length === 1) {
        signalFirstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      const modelId = url.includes("gateway-a") ? "model-a" : "model-b";
      return new Response(JSON.stringify({ data: [{ id: modelId }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const authPath = join(root, "ai-auth.json");
      const customConfigPath = join(root, "ai-providers.json");
      const firstRuntime = createAiRuntime({ authPath, customConfigPath });
      const secondRuntime = createAiRuntime({ authPath, customConfigPath });

      const first = firstRuntime.configureCustomProvider(
        { baseUrl: "http://127.0.0.1:58788/gateway-a" },
        "gateway-a-secret",
      );
      await firstStarted;

      const second = secondRuntime.configureCustomProvider(
        { baseUrl: "http://127.0.0.1:58788/gateway-b" },
        "gateway-b-secret",
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(requests).toHaveLength(1);

      releaseFirst();
      await Promise.all([first, second]);

      expect(requests).toEqual([
        {
          url: "http://127.0.0.1:58788/gateway-a/models",
          authorization: "Bearer gateway-a-secret",
        },
        {
          url: "http://127.0.0.1:58788/gateway-b/models",
          authorization: "Bearer gateway-b-secret",
        },
      ]);
      expect(await secondRuntime.credentials.read("custom-openai")).toEqual({
        type: "api_key",
        key: "gateway-b-secret",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("shares an in-flight custom model refresh across concurrent resolutions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    let modelRequests = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      modelRequests++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ data: [{ id: "proxy-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const runtime = createAiRuntime({
        authPath: join(root, "ai-auth.json"),
        customConfigPath: join(root, "ai-providers.json"),
      });
      await runtime.configureCustomProvider({ baseUrl: "http://127.0.0.1:58788/v1" });
      expect(modelRequests).toBe(1);
      runtime.models.deleteProvider("custom-openai");

      const resolutions = await Promise.all([
        runtime.resolveModel("custom-openai", "proxy-model"),
        runtime.resolveModel("custom-openai", "proxy-model"),
      ]);

      expect(resolutions).toHaveLength(2);
      expect(resolutions[0]?.model.id).toBe("proxy-model");
      expect(resolutions[1]?.model.id).toBe("proxy-model");
      expect(modelRequests).toBe(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects custom endpoint URLs that could carry credentials or query secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const runtime = createAiRuntime({
      authPath: join(root, "ai-auth.json"),
      customConfigPath: join(root, "ai-providers.json"),
    });

    await expect(
      runtime.configureCustomProvider({ baseUrl: "http://user:password@127.0.0.1:58788/v1" }),
    ).rejects.toThrow("must not contain credentials");
    await expect(
      runtime.configureCustomProvider({ baseUrl: "http://127.0.0.1:58788/v1?api_key=secret" }),
    ).rejects.toThrow("must not contain query parameters");
    await expect(
      runtime.configureCustomProvider({ baseUrl: "http://gateway.example/v1" }),
    ).rejects.toThrow("must use https unless it targets loopback");
  });

  it("falls back to a singular /model endpoint for compatible proxies", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "singular-model" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "singular-model" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    try {
      const runtime = createAiRuntime({
        authPath: join(root, "ai-auth.json"),
        customConfigPath: join(root, "ai-providers.json"),
      });
      await runtime.configureCustomProvider({ baseUrl: "http://127.0.0.1:58788/v1" });
      expect(
        (await runtime.listProviders()).find((provider) => provider.id === "custom-openai")
          ?.models[0]?.id,
      ).toBe("singular-model");
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:58788/v1/model", expect.anything());
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("distinguishes ambient API keys from stored credentials and logout does not remove ambient auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const previous = process.env.OPENAI_API_KEY;
    const previousOpenRouter = process.env.OPENROUTER_API_KEY;
    const previousOpenCode = process.env.OPENCODE_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-openai-key";
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      const runtime = createAiRuntime({
        authPath: join(root, "ai-auth.json"),
        customConfigPath: join(root, "ai-providers.json"),
      });
      let openai = (await runtime.listProviders()).find((provider) => provider.id === "openai");
      expect(openai).toMatchObject({
        configured: true,
        authType: "api_key",
        authSource: "OPENAI_API_KEY",
      });
      expect(await runtime.credentials.list()).toEqual([]);

      await runtime.logout("openai");
      openai = (await runtime.listProviders()).find((provider) => provider.id === "openai");
      expect(openai?.authSource).toBe("OPENAI_API_KEY");

      await runtime.saveApiKey("openai", "stored-openai-key");
      openai = (await runtime.listProviders()).find((provider) => provider.id === "openai");
      expect(openai).toMatchObject({ configured: true, authSource: "stored credential" });
      expect((await runtime.credentials.list()).map((entry) => entry.providerId)).toEqual([
        "openai",
      ]);

      await runtime.logout("openai");
      openai = (await runtime.listProviders()).find((provider) => provider.id === "openai");
      expect(openai?.authSource).toBe("OPENAI_API_KEY");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
      if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouter;
      if (previousOpenCode === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousOpenCode;
    }
  });

  it("runs a structured result through the Pi agent loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const credentials = new FileCredentialStore(join(root, "ai-auth.json"));
    const faux = fauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model", name: "Test model" }],
    });
    const models = createModels({ credentials });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("record_result", { ok: true }))]);

    const events: string[] = [];
    const resultTool: AgentTool = {
      name: "record_result",
      label: "Record result",
      description: "Record the result",
      parameters: Type.Object({ ok: Type.Boolean() }),
      execute: async () => ({
        content: [{ type: "text", text: "Recorded" }],
        details: {},
        terminate: true,
      }),
    };
    const runtime = new PiAiRuntime(models, credentials);

    const result = await runtime.runAgent({
      providerId: "test-provider",
      modelId: "test-model",
      systemPrompt: "Return the result through the tool.",
      prompt: "Return ok=true.",
      resultTool,
      onEvent: (event) => events.push(event.type),
    });

    expect(result).toMatchObject({
      providerId: "test-provider",
      providerName: "test-provider",
      modelId: "test-model",
      authType: "api_key",
      authSubscription: false,
      result: { ok: true },
      output: '{"ok":true}',
    });
    expect(events).toContain("tool_execution_start");
    expect(events).toContain("tool_execution_end");
    expect(events).toContain("agent_end");
  });

  it("requires the result tool for OpenAI-compatible AI Studio requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "proxy-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!url.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      const chunks = [
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: "proxy-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call-test",
                    type: "function",
                    index: 0,
                    function: { name: "record_result", arguments: "" },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: "proxy-model",
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"ok":true}' } }] },
            },
          ],
        },
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: "proxy-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];
      const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    try {
      const runtime = createAiRuntime({
        authPath: join(root, "ai-auth.json"),
        customConfigPath: join(root, "ai-providers.json"),
      });
      await runtime.configureCustomProvider({
        name: "Local LiteLLM",
        baseUrl: "http://127.0.0.1:58788/v1",
      });
      const resultTool: AgentTool = {
        name: "record_result",
        label: "Record result",
        description: "Record the result",
        parameters: Type.Object({ ok: Type.Boolean() }),
        execute: async () => ({
          content: [{ type: "text", text: "Recorded" }],
          details: {},
          terminate: true,
        }),
      };

      const result = await runtime.runAgent({
        providerId: "custom-openai",
        modelId: "proxy-model",
        systemPrompt: "Return the result through the tool.",
        prompt: "Return ok=true.",
        resultTool,
      });

      expect(result.result).toEqual({ ok: true });
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]?.tool_choice).toBe("required");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("surfaces provider stream errors instead of reporting an empty response", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const credentials = new FileCredentialStore(join(root, "ai-auth.json"));
    const faux = fauxProvider({
      provider: "failing-provider",
      models: [{ id: "test-model", name: "Test model" }],
    });
    const models = createModels({ credentials });
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "upstream_unreachable",
      }),
    ]);

    const runtime = new PiAiRuntime(models, credentials);
    const resultTool: AgentTool = {
      name: "record_result",
      label: "Record result",
      description: "Record the result",
      parameters: Type.Object({ ok: Type.Boolean() }),
      execute: async () => ({
        content: [{ type: "text", text: "Recorded" }],
        details: {},
        terminate: true,
      }),
    };

    await expect(
      runtime.runAgent({
        providerId: "failing-provider",
        modelId: "test-model",
        systemPrompt: "Return a result.",
        prompt: "Return ok=true.",
        resultTool,
      }),
    ).rejects.toThrow("failing-provider request failed: upstream_unreachable");
  });

  it("refreshes an expired OAuth credential only once for concurrent auth requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const credentials = new FileCredentialStore(join(root, "ai-auth.json"));
    const faux = fauxProvider({
      provider: "test-oauth",
      models: [{ id: "test-model", name: "Test model" }],
    });
    let refreshCount = 0;
    const models = createModels({ credentials });
    models.setProvider({
      ...faux.provider,
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async () => ({
            type: "oauth" as const,
            access: "new-access",
            refresh: "new-refresh",
            expires: Date.now() + 60 * 60 * 1000,
          }),
          refresh: async (current) => {
            refreshCount++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              ...current,
              access: "new-access",
              expires: Date.now() + 60 * 60 * 1000,
            };
          },
          toAuth: async (current) => ({ apiKey: current.access }),
        },
      },
    });
    await credentials.modify("test-oauth", async () => ({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1,
    }));

    const auth = await Promise.all([models.getAuth("test-oauth"), models.getAuth("test-oauth")]);

    expect(refreshCount).toBe(1);
    expect(auth.map((entry) => entry?.auth.apiKey)).toEqual(["new-access", "new-access"]);
    expect((await credentials.read("test-oauth"))?.type).toBe("oauth");
  });

  it("does not fall back to an API key when a stored OAuth refresh fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const credentials = new FileCredentialStore(join(root, "ai-auth.json"));
    const faux = fauxProvider({
      provider: "oauth-owned",
      models: [{ id: "test-model", name: "Test model" }],
    });
    const models = createModels({ credentials });
    models.setProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Ambient API key",
          resolve: async () => ({ auth: { apiKey: "ambient-api-key" }, source: "TEST_ENV" }),
        },
        oauth: {
          name: "Stored OAuth",
          login: async () => {
            throw new Error("not used");
          },
          refresh: async () => {
            throw new Error("refresh failed");
          },
          toAuth: async (current) => ({ apiKey: current.access }),
        },
      },
    });
    await credentials.modify("oauth-owned", async () => ({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1,
    }));

    await expect(models.getAuth("oauth-owned")).rejects.toThrow("OAuth refresh failed");
    expect((await credentials.read("oauth-owned"))?.access).toBe("old-access");
  });

  it("cancels provider-owned OAuth login when the browser request is aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const credentials = new FileCredentialStore(join(root, "ai-auth.json"));
    const faux = fauxProvider({
      provider: "login-cancellation",
      models: [{ id: "test-model", name: "Test model" }],
    });
    const models = createModels({ credentials });
    let providerSignal!: AbortSignal;
    models.setProvider({
      ...faux.provider,
      auth: {
        oauth: {
          name: "Cancellable OAuth",
          login: async (interaction) =>
            new Promise((_resolve, reject) => {
              providerSignal = interaction.signal;
              interaction.signal.addEventListener(
                "abort",
                () => reject(interaction.signal.reason),
                {
                  once: true,
                },
              );
            }),
          refresh: async (current) => current,
          toAuth: async (current) => ({ apiKey: current.access }),
        },
      },
    });
    const runtime = new PiAiRuntime(models, credentials);
    const controller = new AbortController();
    const login = runtime.login("login-cancellation", "oauth", {
      signal: controller.signal,
      prompt: async () => "browser",
      notify: () => {},
    });
    for (let attempt = 0; attempt < 100 && !providerSignal; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(providerSignal).toBeDefined();
    controller.abort();

    await expect(login).rejects.toThrow("AI authentication cancelled");
    expect(await credentials.list()).toEqual([]);
  });

  it("includes model resolution in the operation timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const credentials = new FileCredentialStore(join(root, "ai-auth.json"));
    const faux = fauxProvider({
      provider: "slow-oauth",
      models: [{ id: "test-model", name: "Test model" }],
    });
    const models = createModels({ credentials });
    models.setProvider({
      ...faux.provider,
      auth: {
        oauth: {
          name: "Slow OAuth",
          login: async () => {
            throw new Error("not used");
          },
          refresh: async (_current, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          toAuth: async (current) => ({ apiKey: current.access }),
        },
      },
    });
    await credentials.modify("slow-oauth", async () => ({
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1,
    }));

    const runtime = new PiAiRuntime(models, credentials);
    const resultTool: AgentTool = {
      name: "record_result",
      label: "Record result",
      description: "Record the result",
      parameters: Type.Object({ ok: Type.Boolean() }),
      execute: async () => ({
        content: [{ type: "text", text: "Recorded" }],
        details: {},
        terminate: true,
      }),
    };

    await expect(
      runtime.runAgent({
        providerId: "slow-oauth",
        systemPrompt: "Return a result.",
        prompt: "Return ok=true.",
        resultTool,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("AI Studio operation timed out after 20ms");
  });

  it("redacts stored credentials from user-visible errors and model output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-ai-runtime-"));
    temporaryRoots.push(root);
    const credentials = new FileCredentialStore(join(root, "ai-auth.json"));
    const faux = fauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model", name: "Test model" }],
    });
    const models = createModels({ credentials });
    models.setProvider(faux.provider);
    const other = fauxProvider({
      provider: "other-provider",
      models: [{ id: "other-model", name: "Other model" }],
    });
    models.setProvider(other.provider);
    await credentials.modify("test-provider", async () => ({
      type: "api_key",
      key: "custom-secret-key-123",
    }));
    await credentials.modify("other-provider", async () => ({
      type: "api_key",
      key: "other-secret-key-456",
    }));
    const runtime = new PiAiRuntime(models, credentials);

    await credentials.modify("test-provider", async () => ({ type: "api_key", key: "tiny" }));
    expect(await runtime.getSafeErrorMessage(new Error("request failed tiny"))).toBe(
      "request failed [REDACTED]",
    );
    await credentials.modify("test-provider", async () => ({
      type: "api_key",
      key: "custom-secret-key-123",
    }));

    expect(
      await runtime.getSafeErrorMessage(new Error("request failed custom-secret-key-123")),
    ).toBe("request failed [REDACTED]");
    const safeOAuthError = await runtime.getSafeErrorMessage(
      new Error(
        '{"access_token":"unpersisted-access-token","refresh_token":"unpersisted-refresh-token"}',
      ),
    );
    expect(safeOAuthError).not.toContain("unpersisted-access-token");
    expect(safeOAuthError).not.toContain("unpersisted-refresh-token");

    faux.setResponses([
      fauxAssistantMessage(
        "The credentials were custom-secret-key-123, other-secret-key-456, and sk-abcdefghijklmnopqrstuvwxyz",
      ),
    ]);
    const resultTool: AgentTool = {
      name: "record_result",
      label: "Record result",
      description: "Record the result",
      parameters: Type.Object({ ok: Type.Boolean() }),
      execute: async () => ({
        content: [{ type: "text", text: "Recorded" }],
        details: {},
        terminate: true,
      }),
    };
    const result = await runtime.runAgent({
      providerId: "test-provider",
      modelId: "test-model",
      systemPrompt: "Answer.",
      prompt: "Answer.",
      resultTool,
    });
    expect(result.output).not.toContain("custom-secret-key-123");
    expect(result.output).not.toContain("other-secret-key-456");
    expect(result.output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("exposes provider auth methods without secrets", () => {
    const faux = fauxProvider({
      provider: "test-provider",
      models: [{ id: "test-model" }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiAiRuntime(models, new FileCredentialStore("/tmp/unused-vibe-auth.json"));

    return expect(runtime.listProviders()).resolves.toEqual([
      expect.objectContaining({
        id: "test-provider",
        configured: true,
        authMethods: [{ type: "api_key", label: "Faux", subscription: false }],
        models: [expect.objectContaining({ id: "test-model" })],
      }),
    ]);
  });
});

describe("browser authentication interaction", () => {
  it("cancels a pending manual-code prompt when the outer request aborts", async () => {
    const controller = new AbortController();
    const interaction = createBrowserAuthInteraction(controller.signal);
    const pending = interaction.prompt({ type: "manual_code", message: "" });
    controller.abort();

    await expect(pending).rejects.toThrow("Browser authentication cancelled");
  });

  it("lets a provider-owned callback beat the pending manual-code branch", async () => {
    const previousAutoOpen = process.env.VIBE_REPLAY_NO_AUTO_OPEN;
    process.env.VIBE_REPLAY_NO_AUTO_OPEN = "1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ key: "sk-or-v1-callback-result" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    let login: Promise<unknown> | undefined;
    const loginController = new AbortController();
    try {
      const provider = openrouterProvider();
      const oauth = provider.auth.oauth;
      if (!oauth) throw new Error("OpenRouter OAuth is unavailable");

      let authUrl: string | undefined;
      const baseInteraction = createBrowserAuthInteraction(loginController.signal);
      login = oauth.login({
        ...baseInteraction,
        signal: loginController.signal,
        notify: (event) => {
          baseInteraction.notify(event);
          if (event.type === "auth_url") authUrl = event.url;
        },
      });

      for (let attempt = 0; attempt < 100 && !authUrl; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(authUrl).toBeDefined();
      const callbackRaw = new URL(authUrl!).searchParams.get("callback_url");
      expect(callbackRaw).toBeTruthy();
      const callbackUrl = new URL(callbackRaw!);
      callbackUrl.searchParams.set("code", "browser-callback-code");
      const status = await requestCallback(callbackUrl);
      expect(status).toBe(200);

      await expect(login).resolves.toMatchObject({
        type: "oauth",
        access: "sk-or-v1-callback-result",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      loginController.abort();
      if (login) await login.catch(() => {});
      fetchMock.mockRestore();
      if (previousAutoOpen === undefined) delete process.env.VIBE_REPLAY_NO_AUTO_OPEN;
      else process.env.VIBE_REPLAY_NO_AUTO_OPEN = previousAutoOpen;
    }
  });
});

function requestCallback(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    req.once("error", reject);
    req.end();
  });
}
