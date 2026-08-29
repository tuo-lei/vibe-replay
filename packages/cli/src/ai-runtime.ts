import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open as openFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import open from "open";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createProvider,
  createModels,
  type Api,
  type AuthCheck,
  type AuthEvent,
  type AuthInteraction,
  type AuthOperationOptions,
  type AuthPrompt,
  type AuthType,
  type Credential,
  type CredentialStore,
  type Model,
  type MutableModels,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const DEFAULT_AI_AUTH_PATH = join(homedir(), ".vibe-replay", "ai-auth.json");
const DEFAULT_AI_CONFIG_PATH = join(homedir(), ".vibe-replay", "ai-providers.json");
const CREDENTIAL_LOCK_WAIT_MS = 25;
const CREDENTIAL_LOCK_TIMEOUT_MS = 30_000;
const CREDENTIAL_LOCK_STALE_MS = 60_000;
const AI_AUTH_OPERATION_TIMEOUT_MS = 600_000;
const CUSTOM_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const CUSTOM_MODEL_DISCOVERY_MAX_BYTES = 1_048_576;
// The agent-core wrapper does not forward maxRetries to pi-ai. Keep a small,
// interruptible retry budget here so a transient 5xx from a local gateway does
// not become an empty AI Studio result.
const AI_REQUEST_MAX_RETRIES = 2;
const AI_REQUEST_MAX_RETRY_DELAY_MS = 10_000;
const CUSTOM_OPENAI_NO_KEY = "vibe-replay-local-endpoint";

export const CUSTOM_OPENAI_PROVIDER_ID = "custom-openai";
export const DEFAULT_CUSTOM_OPENAI_NAME = "Custom OpenAI-compatible";

export type AiProviderId =
  | "openai"
  | "openai-codex"
  | "openrouter"
  | "opencode"
  | typeof CUSTOM_OPENAI_PROVIDER_ID;

export interface CustomAiProviderConfig {
  name: string;
  baseUrl: string;
}

export interface CustomAiProviderConfigInput {
  name?: string;
  baseUrl: string;
}

export interface CustomAiProviderConfigStore {
  read(options?: AuthOperationOptions): Promise<CustomAiProviderConfig | undefined>;
  write(config: CustomAiProviderConfig, options?: AuthOperationOptions): Promise<void>;
  delete(options?: AuthOperationOptions): Promise<void>;
}

export interface AiAuthMethodInfo {
  type: AuthType;
  label: string;
  subscription: boolean;
}

export interface AiModelInfo {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
}

export interface AiProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  authType?: AuthType;
  authSource?: string;
  authMethods: AiAuthMethodInfo[];
  models: AiModelInfo[];
  /** Present only for the user-configured OpenAI-compatible provider. */
  custom?: { baseUrl: string };
  /** A safe, non-secret model discovery error for dynamic providers. */
  modelError?: string;
}

export interface AiModelResolution {
  provider: Provider;
  model: Model<Api>;
  auth: AuthCheck;
}

export interface PiAgentRunOptions {
  providerId: string;
  modelId?: string;
  systemPrompt: string;
  prompt: string;
  /** Additional domain tools available to the agent. */
  tools?: AgentTool[];
  /** Optional structured result tool used by the existing AI Studio flows. */
  resultTool?: AgentTool;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Maximum number of domain-tool calls allowed in one agent run. */
  maxToolCalls?: number;
  sessionId?: string;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface PiAgentRunResult {
  providerId: string;
  providerName: string;
  modelId: string;
  authType: AuthType;
  authSubscription: boolean;
  authSource?: string;
  output: string;
  result?: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value) || (value.type !== "api_key" && value.type !== "oauth")) {
    return false;
  }

  if (value.type === "api_key") {
    return (
      (value.key === undefined || (typeof value.key === "string" && value.key.length > 0)) &&
      (value.env === undefined || isStringRecord(value.env))
    );
  }

  return (
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  );
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Wait for an operation to finish, but let a caller stop waiting immediately. */
function raceWithAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function acquireFileLock(
  filePath: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + CREDENTIAL_LOCK_TIMEOUT_MS;

  const clearStaleLock = async (): Promise<boolean> => {
    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }

    if (Date.now() - lockStat.mtimeMs < CREDENTIAL_LOCK_STALE_MS) return false;

    const owner = await readFile(lockPath, "utf8").catch(() => "");
    const pid = Number.parseInt(owner.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      }
    }

    await rm(lockPath, { force: true });
    return true;
  };

  while (true) {
    signal?.throwIfAborted();
    let handle: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      handle = await openFile(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      handle = undefined;
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      if (await clearStaleLock()) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for AI credential store lock: ${filePath}`, {
          cause: error,
        });
      }
      await raceWithAbortSignal(
        new Promise<void>((resolve) => setTimeout(resolve, CREDENTIAL_LOCK_WAIT_MS)),
        signal,
      );
    }
  }
}

async function persistJsonFile(
  filePath: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  signal?.throwIfAborted();

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    signal?.throwIfAborted();
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

const AI_AUTH_ENV_VARS = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"];

/**
 * Remove credential-shaped values from user-visible AI errors and model output.
 * Exact credential values are supplied separately because OAuth refresh tokens
 * do not necessarily have a recognizable prefix.
 */
export function redactSensitiveText(text: string, exactSecrets: readonly string[] = []): string {
  let result = text;

  for (const secret of [...new Set(exactSecrets)].sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }

  const patterns: Array<{ pattern: RegExp; replacement?: (match: string) => string }> = [
    {
      pattern:
        /\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pous]_[a-zA-Z0-9_]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g,
    },
    { pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g },
    { pattern: /\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}/gi },
    {
      pattern:
        /([?&](?:access_token|refresh_token|id_token|api_key|code_verifier|authorization|authorization_code|client_secret|device_code|user_code)=)[^&#\s]+/gi,
      replacement: (match) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`,
    },
    {
      pattern:
        /["']?(?:access_token|refresh_token|id_token|api[_-]?key|client[_-]?secret|code_verifier|authorization|authorization_code|device_code|user_code)["']?\s*:\s*["'][^"']*["']/gi,
      replacement: (match) => {
        const separator = match.indexOf(":");
        const quote = match.slice(separator + 1).match(/["']/)?.[0] || '"';
        return `${match.slice(0, separator + 1)}${quote}[REDACTED]${quote}`;
      },
    },
    {
      pattern:
        /\b((?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|SECRET)[_A-Z-]*\s*[=:]\s*["']?)[^\s"',;&]+/gi,
      replacement: (match) => {
        const separator = match.search(/[=:]/);
        return separator >= 0 ? `${match.slice(0, separator + 1)} [REDACTED]` : "[REDACTED]";
      },
    },
    {
      pattern:
        /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    },
  ];

  for (const { pattern, replacement } of patterns) {
    if (replacement) result = result.replace(pattern, replacement);
    else result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function redactUnknown(value: unknown, exactSecrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSensitiveText(value, exactSecrets);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, exactSecrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry, exactSecrets)]),
  );
}

/**
 * Small app-owned credential store for Pi's provider layer.
 *
 * Pi's `CredentialStore` deliberately leaves persistence to the embedding app.
 * Keep the file outside replay directories and use an atomic 0600 write so
 * provider keys and OAuth refresh tokens never enter replay or cloud data.
 */
export class FileCredentialStore implements CredentialStore {
  private data: Record<string, Credential> = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = DEFAULT_AI_AUTH_PATH) {}

  private async loadFromDisk(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed)) {
        throw new Error(`Invalid AI credential store: ${this.filePath}`);
      }
      for (const [providerId, credential] of Object.entries(parsed)) {
        if (!isCredential(credential)) {
          throw new Error(`Invalid AI credential for provider ${providerId}`);
        }
      }
      this.data = clone(parsed as Record<string, Credential>);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = {};
        return;
      }
      throw error;
    }
  }

  private async acquireLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    return acquireFileLock(this.filePath, signal);
  }

  private async withLock<T>(signal: AbortSignal | undefined, operation: () => Promise<T>) {
    const release = await this.acquireLock(signal);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async persist(data: Record<string, Credential>, signal?: AbortSignal): Promise<void> {
    await persistJsonFile(this.filePath, data, signal);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    await raceWithAbortSignal(this.loadFromDisk(), options?.signal);
    options?.signal?.throwIfAborted();
    const credential = this.data[providerId];
    return credential ? clone(credential) : undefined;
  }

  async list(
    options?: AuthOperationOptions,
  ): Promise<ReadonlyArray<{ providerId: string; type: Credential["type"] }>> {
    options?.signal?.throwIfAborted();
    await raceWithAbortSignal(this.loadFromDisk(), options?.signal);
    options?.signal?.throwIfAborted();
    return Object.entries(this.data).flatMap(([providerId, credential]) => {
      return [{ providerId, type: credential.type }];
    });
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const operation = this.enqueue(async () => {
      return this.withLock(options?.signal, async () => {
        await raceWithAbortSignal(this.loadFromDisk(), options?.signal);
        options?.signal?.throwIfAborted();
        const current = this.data[providerId];
        const next = await fn(current ? clone(current) : undefined);
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          if (!isCredential(next)) {
            throw new Error(`Invalid AI credential for provider ${providerId}`);
          }
          const nextCredential = clone(next);
          const nextData = { ...this.data, [providerId]: nextCredential };
          await this.persist(nextData, options?.signal);
          this.data = nextData;
          return clone(nextCredential);
        }
        return current ? clone(current) : undefined;
      });
    });
    return raceWithAbortSignal(operation, options?.signal);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    const operation = this.enqueue(async () => {
      await this.withLock(options?.signal, async () => {
        await raceWithAbortSignal(this.loadFromDisk(), options?.signal);
        options?.signal?.throwIfAborted();
        if (!(providerId in this.data)) return;
        const nextData = { ...this.data };
        delete nextData[providerId];
        await this.persist(nextData, options?.signal);
        this.data = nextData;
      });
    });
    await raceWithAbortSignal(operation, options?.signal);
  }
}

function isCustomAiProviderConfig(value: unknown): value is CustomAiProviderConfig {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 120 &&
    !/[\r\n]/.test(value.name) &&
    typeof value.baseUrl === "string" &&
    value.baseUrl.length > 0 &&
    value.baseUrl.length <= 2_048
  );
}

/**
 * Normalize the base URL for an OpenAI-compatible server.
 *
 * The OpenAI adapter appends `/chat/completions`, while model discovery uses
 * `/models`, so the value stored here must be an API root rather than either
 * endpoint. A bare origin is convenient for local LiteLLM-style proxies and
 * is normalized to `/v1`.
 */
export function normalizeCustomAiBaseUrl(rawBaseUrl: string): string {
  const value = rawBaseUrl.trim();
  if (!value) throw new Error("Custom AI endpoint is required");
  if (value.length > 2_048) throw new Error("Custom AI endpoint is too long");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Custom AI endpoint must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Custom AI endpoint must use http or https");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Custom AI endpoint must use https unless it targets loopback");
  }
  if (url.username || url.password) {
    throw new Error("Custom AI endpoint must not contain credentials in the URL");
  }
  if (url.search || url.hash) {
    throw new Error("Custom AI endpoint must not contain query parameters or fragments");
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname) pathname = "/v1";
  if (pathname.endsWith("/models") || pathname.endsWith("/model")) {
    throw new Error("Enter the custom AI API root, not its models endpoint");
  }
  if (pathname.endsWith("/chat/completions") || pathname.endsWith("/completions")) {
    throw new Error("Enter the custom AI API root, not its completion endpoint");
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

function normalizeCustomAiProviderConfig(
  input: CustomAiProviderConfigInput,
): CustomAiProviderConfig {
  const name = input.name?.trim() || DEFAULT_CUSTOM_OPENAI_NAME;
  if (name.length > 120 || /[\r\n]/.test(name)) {
    throw new Error("Custom AI provider name must be at most 120 characters");
  }
  return {
    name,
    baseUrl: normalizeCustomAiBaseUrl(input.baseUrl),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  const firstOctet = Number.parseInt(normalized.split(".")[0] || "", 10);
  return firstOctet === 127;
}

/** Stores only the custom endpoint metadata; API keys stay in FileCredentialStore. */
export class FileCustomProviderConfigStore implements CustomAiProviderConfigStore {
  private data: CustomAiProviderConfig | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = DEFAULT_AI_CONFIG_PATH) {}

  private async loadFromDisk(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed)) {
        throw new Error(`Invalid AI provider configuration: ${this.filePath}`);
      }
      if (parsed.customOpenAi !== undefined && !isCustomAiProviderConfig(parsed.customOpenAi)) {
        throw new Error(`Invalid custom AI provider configuration: ${this.filePath}`);
      }
      this.data = parsed.customOpenAi
        ? normalizeCustomAiProviderConfig(parsed.customOpenAi)
        : undefined;
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = undefined;
        return;
      }
      throw error;
    }
  }

  private async withLock<T>(signal: AbortSignal | undefined, operation: () => Promise<T>) {
    const release = await acquireFileLock(this.filePath, signal);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async read(options?: AuthOperationOptions): Promise<CustomAiProviderConfig | undefined> {
    options?.signal?.throwIfAborted();
    await raceWithAbortSignal(this.loadFromDisk(), options?.signal);
    options?.signal?.throwIfAborted();
    return this.data ? clone(this.data) : undefined;
  }

  async write(config: CustomAiProviderConfig, options?: AuthOperationOptions): Promise<void> {
    if (!isCustomAiProviderConfig(config)) {
      throw new Error("Invalid custom AI provider configuration");
    }
    const operation = this.enqueue(async () => {
      await this.withLock(options?.signal, async () => {
        await raceWithAbortSignal(this.loadFromDisk(), options?.signal);
        options?.signal?.throwIfAborted();
        await persistJsonFile(this.filePath, { customOpenAi: clone(config) }, options?.signal);
        this.data = clone(config);
      });
    });
    await raceWithAbortSignal(operation, options?.signal);
  }

  async delete(options?: AuthOperationOptions): Promise<void> {
    const operation = this.enqueue(async () => {
      await this.withLock(options?.signal, async () => {
        await raceWithAbortSignal(this.loadFromDisk(), options?.signal);
        options?.signal?.throwIfAborted();
        await rm(this.filePath, { force: true });
        this.data = undefined;
      });
    });
    await raceWithAbortSignal(operation, options?.signal);
  }
}

export function getAiAuthPath(): string {
  return process.env.VIBE_REPLAY_AI_AUTH?.trim() || DEFAULT_AI_AUTH_PATH;
}

export function getAiConfigPath(): string {
  return process.env.VIBE_REPLAY_AI_CONFIG?.trim() || DEFAULT_AI_CONFIG_PATH;
}

export interface AiDefaultSelection {
  providerId?: string;
  modelId?: string;
  /** Provider identity used to map Pi custom gateways to Vibe Replay. */
  baseUrl?: string;
}

/**
 * Pi keeps the user's provider/model preference in a non-secret settings file.
 * Reuse that preference when the embedded runtime can map it to one of the
 * providers available to Vibe Replay (for example, a local gateway model).
 */
export async function readPiDefaultAiSelection(): Promise<AiDefaultSelection | undefined> {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  try {
    const raw = await readFile(join(agentDir, "settings.json"), "utf8");
    const value = JSON.parse(raw) as Record<string, unknown>;
    const providerId =
      typeof value.defaultProvider === "string" ? value.defaultProvider : undefined;
    const modelId = typeof value.defaultModel === "string" ? value.defaultModel : undefined;
    if (!providerId && !modelId) return undefined;
    let baseUrl: string | undefined;
    if (providerId) {
      try {
        const modelsRaw = await readFile(join(agentDir, "models.json"), "utf8");
        const modelsConfig = JSON.parse(modelsRaw) as unknown;
        const providers = isRecord(modelsConfig) ? modelsConfig.providers : undefined;
        const provider = isRecord(providers) ? providers[providerId] : undefined;
        baseUrl =
          isRecord(provider) && typeof provider.baseUrl === "string" ? provider.baseUrl : undefined;
      } catch {
        // settings.json is sufficient for built-in Pi providers; models.json
        // is only needed to identify a separately named custom gateway.
      }
    }
    return {
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  } catch {
    // Pi is optional; a missing or malformed settings file should not affect
    // the built-in provider registry.
    return undefined;
  }
}

export interface AiRuntime {
  readonly models: Models;
  readonly credentials: CredentialStore;
  listProviders(options?: AuthOperationOptions): Promise<AiProviderInfo[]>;
  resolveModel(
    providerId: string,
    modelId?: string,
    options?: AuthOperationOptions,
  ): Promise<AiModelResolution>;
  configureCustomProvider(
    config: CustomAiProviderConfigInput,
    apiKey?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  removeCustomProvider(signal?: AbortSignal): Promise<void>;
  saveApiKey(providerId: string, apiKey: string, signal?: AbortSignal): Promise<void>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string, signal?: AbortSignal): Promise<void>;
  getSafeErrorMessage(error: unknown): Promise<string>;
  runAgent(options: PiAgentRunOptions): Promise<PiAgentRunResult>;
}

function providerAuthMethods(provider: Provider): AiAuthMethodInfo[] {
  const methods: AiAuthMethodInfo[] = [];
  if (provider.auth.apiKey) {
    methods.push({
      type: "api_key",
      label: provider.auth.apiKey.name,
      subscription: false,
    });
  }
  if (provider.auth.oauth) {
    methods.push({
      type: "oauth",
      label: provider.auth.oauth.loginLabel || provider.auth.oauth.name,
      subscription: provider.auth.oauth.isSubscription === true,
    });
  }
  return methods;
}

function modelInfo(model: Model<Api>): AiModelInfo {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
  };
}

function assistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    return message.content
      .flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("");
  }
  return "";
}

function assistantFailure(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
      return message.errorMessage.trim();
    }
    if (message.stopReason === "length") {
      return "The provider response was truncated before AI Studio received a result";
    }
    if (message.stopReason === "error") {
      return "The provider returned an error without a usable response";
    }
  }
  return undefined;
}

function requireToolPayload(payload: unknown, required: boolean): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.tools) || payload.tools.length === 0) {
    return payload;
  }
  // OpenAI-compatible gateways understand `required`, and AI Studio only gives
  // the agent one result tool. This prevents a model that emits an empty
  // assistant message from making an otherwise healthy request look like a
  // provider failure.
  return required ? { ...payload, tool_choice: "required" } : payload;
}

function customEndpointUrl(baseUrl: string, endpoint: "models" | "model"): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
}

function customAuthHeaders(apiKey?: string): Record<string, string> {
  return apiKey
    ? { Accept: "application/json", Authorization: `Bearer ${apiKey}` }
    : { Accept: "application/json" };
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), 2_000_000_000);
}

function modelInput(raw: Record<string, unknown>): ("text" | "image")[] {
  const modalities = [raw.modalities, raw.input_modalities, raw.input].find((value) =>
    Array.isArray(value),
  ) as unknown[] | undefined;
  if (modalities?.some((value) => typeof value === "string" && /image|vision/i.test(value))) {
    return ["text", "image"];
  }
  return ["text"];
}

function customModelFromDiscovery(
  raw: unknown,
  config: CustomAiProviderConfig,
): Model<"openai-completions"> | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") return undefined;
  const id = raw.id.trim();
  if (!id || id.length > 512 || /[\r\n]/.test(id)) return undefined;
  const nameValue = typeof raw.name === "string" ? raw.name.trim() : "";
  const contextWindow = positiveNumber(
    raw.context_length ?? raw.context_window ?? raw.max_context_length ?? raw.max_model_len,
    128_000,
  );
  const maxTokens = positiveNumber(
    raw.max_output_tokens ?? raw.max_tokens ?? raw.max_completion_tokens,
    Math.min(contextWindow, 32_768),
  );
  const reasoning =
    raw.reasoning === true ||
    raw.supports_reasoning === true ||
    (isRecord(raw.capabilities) && raw.capabilities.reasoning === true);

  return {
    id,
    name: nameValue.slice(0, 256) || id,
    api: "openai-completions",
    provider: CUSTOM_OPENAI_PROVIDER_ID,
    baseUrl: config.baseUrl,
    reasoning,
    input: modelInput(raw),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    // Unknown OpenAI-compatible proxies are more interoperable when Pi sends
    // the legacy system role, max_tokens, and ordinary JSON-schema tools.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
  };
}

async function readCustomModelsResponse(
  response: Response,
  endpoint: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    // Do not include a provider response body: proxies sometimes echo
    // Authorization headers or upstream credentials in error payloads.
    throw new Error(`Custom AI model discovery failed at ${endpoint} (HTTP ${response.status})`);
  }
  let body: string;
  if (!response.body) {
    body = await response.text();
    if (new TextEncoder().encode(body).byteLength > CUSTOM_MODEL_DISCOVERY_MAX_BYTES) {
      throw new Error("Custom AI model discovery response is too large");
    }
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > CUSTOM_MODEL_DISCOVERY_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error("Custom AI model discovery response is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = new TextDecoder().decode(bytes);
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Custom AI model discovery returned invalid JSON");
  }
}

async function fetchCustomModels(
  config: CustomAiProviderConfig,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<readonly Model<"openai-completions">[]> {
  const headers = customAuthHeaders(apiKey);
  const modelsEndpoint = customEndpointUrl(config.baseUrl, "models");
  let response = await fetch(modelsEndpoint, { headers, signal });
  let endpoint = modelsEndpoint;
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    const singularEndpoint = customEndpointUrl(config.baseUrl, "model");
    response = await fetch(singularEndpoint, { headers, signal });
    endpoint = singularEndpoint;
  }

  const payload = await readCustomModelsResponse(response, endpoint, signal);
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : isRecord(payload) && typeof payload.id === "string"
          ? [payload]
          : undefined;
  if (!entries) {
    throw new Error("Custom AI model discovery response must contain a models list");
  }

  const models: Model<"openai-completions">[] = [];
  const ids = new Set<string>();
  for (const entry of entries.slice(0, 512)) {
    const model = customModelFromDiscovery(entry, config);
    if (!model || ids.has(model.id)) continue;
    ids.add(model.id);
    models.push(model);
  }
  if (models.length === 0) throw new Error("Custom AI model discovery returned no usable models");
  return models;
}

function customProvider(config: CustomAiProviderConfig): Provider {
  return createProvider({
    id: CUSTOM_OPENAI_PROVIDER_ID,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: `${config.name} API key`,
        resolve: async ({ credential }) => {
          const key = credential?.type === "api_key" ? credential.key?.trim() : undefined;
          return {
            auth: { apiKey: key || CUSTOM_OPENAI_NO_KEY },
            source: key ? "stored credential" : "custom endpoint",
          };
        },
      },
    },
    models: [],
    fetchModels: async ({ credential, signal }) => {
      const key =
        credential?.type === "api_key" && credential.key !== CUSTOM_OPENAI_NO_KEY
          ? credential.key
          : undefined;
      return fetchCustomModels(config, key, signal);
    },
    api: openAICompletionsApi(),
  });
}

export class PiAiRuntime implements AiRuntime {
  private readonly customConfigStore?: CustomAiProviderConfigStore;
  private readonly customConfigMutationLockPath?: string;
  private customConfigMutationChain: Promise<void> = Promise.resolve();
  private customConfig?: CustomAiProviderConfig;
  private customModelError?: string;
  private customRefresh?: Promise<void>;

  constructor(
    public readonly models: MutableModels,
    public readonly credentials: CredentialStore,
    customConfigStore?: CustomAiProviderConfigStore,
    customConfigMutationLockPath?: string,
  ) {
    this.customConfigStore = customConfigStore;
    this.customConfigMutationLockPath = customConfigMutationLockPath;
  }

  private async withCustomConfigMutationLock<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.customConfigMutationLockPath) return operation();
    const release = await acquireFileLock(this.customConfigMutationLockPath, signal);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private enqueueCustomConfigMutation<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      signal?.throwIfAborted();
      return this.withCustomConfigMutationLock(signal, operation);
    };
    const queued = this.customConfigMutationChain.then(run, run);
    this.customConfigMutationChain = queued.then(
      () => undefined,
      () => undefined,
    );
    return raceWithAbortSignal(queued, signal);
  }

  private async ensureCustomProvider(signal?: AbortSignal): Promise<Provider | undefined> {
    if (!this.customConfigStore) return undefined;
    const config = await this.customConfigStore.read({ signal });
    const installed = this.models.getProvider(CUSTOM_OPENAI_PROVIDER_ID);
    if (!config) {
      if (installed) this.models.deleteProvider(CUSTOM_OPENAI_PROVIDER_ID);
      this.customConfig = undefined;
      this.customModelError = undefined;
      return undefined;
    }

    if (
      !installed ||
      !this.customConfig ||
      this.customConfig.name !== config.name ||
      this.customConfig.baseUrl !== config.baseUrl
    ) {
      this.models.setProvider(customProvider(config));
      this.customConfig = config;
      this.customModelError = undefined;
    }
    return this.models.getProvider(CUSTOM_OPENAI_PROVIDER_ID);
  }

  private async refreshCustomProviderOnce(signal?: AbortSignal): Promise<void> {
    const provider = await this.ensureCustomProvider(signal);
    if (!provider || !provider.refreshModels) return;

    const timeoutSignal = AbortSignal.timeout(CUSTOM_MODEL_DISCOVERY_TIMEOUT_MS);
    const refreshSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const result = await this.models.refresh({
      providers: [CUSTOM_OPENAI_PROVIDER_ID],
      signal: refreshSignal,
      force: true,
    });
    signal?.throwIfAborted();
    if (result.aborted && refreshSignal.aborted) {
      if (signal?.aborted) signal.throwIfAborted();
      throw new Error(
        `Custom AI model discovery timed out after ${CUSTOM_MODEL_DISCOVERY_TIMEOUT_MS}ms`,
      );
    }
    const error = result.errors.get(CUSTOM_OPENAI_PROVIDER_ID);
    this.customModelError = error ? await this.getSafeErrorMessage(error) : undefined;
  }

  private refreshCustomProvider(signal?: AbortSignal): Promise<void> {
    if (this.customRefresh) {
      return raceWithAbortSignal(this.customRefresh, signal);
    }

    const operation = this.refreshCustomProviderOnce(signal);
    const tracked = operation.finally(() => {
      if (this.customRefresh === tracked) this.customRefresh = undefined;
    });
    this.customRefresh = tracked;
    return raceWithAbortSignal(tracked, signal);
  }

  async listProviders(options?: AuthOperationOptions): Promise<AiProviderInfo[]> {
    await this.ensureCustomProvider(options?.signal);
    await this.refreshCustomProvider(options?.signal);
    return Promise.all(
      this.models.getProviders().map(async (provider) => {
        const auth = await this.models.checkAuth(provider.id, options);
        const info: AiProviderInfo = {
          id: provider.id,
          name: provider.name,
          configured: auth !== undefined,
          authType: auth?.type,
          authSource: auth?.source,
          authMethods: providerAuthMethods(provider),
          models: provider.getModels().map(modelInfo),
        };
        if (provider.id === CUSTOM_OPENAI_PROVIDER_ID && this.customConfig) {
          info.custom = { baseUrl: this.customConfig.baseUrl };
          if (this.customModelError) info.modelError = this.customModelError;
        }
        return info;
      }),
    );
  }

  async resolveModel(
    providerId: string,
    modelId?: string,
    options?: AuthOperationOptions,
  ): Promise<AiModelResolution> {
    if (providerId === CUSTOM_OPENAI_PROVIDER_ID) {
      const provider = await this.ensureCustomProvider(options?.signal);
      if (provider && provider.getModels().length === 0) {
        await this.refreshCustomProvider(options?.signal);
      }
    }
    const provider = this.models.getProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown AI provider: ${providerId}`);
    }

    const auth = await this.models.checkAuth(providerId, options);
    if (!auth) {
      throw new Error(`${provider.name} is not configured. Set up this provider first.`);
    }

    const model = modelId
      ? this.models.getModel(providerId, modelId)
      : (await this.models.getAvailable(providerId, options))[0];
    if (modelId && !model) {
      if (providerId === CUSTOM_OPENAI_PROVIDER_ID && provider.getModels().length === 0) {
        if (this.customModelError) throw new Error(this.customModelError);
      }
      throw new Error(`${provider.name} does not provide model "${modelId}"`);
    }
    if (!model) {
      if (providerId === CUSTOM_OPENAI_PROVIDER_ID && this.customModelError) {
        throw new Error(this.customModelError);
      }
      throw new Error(`No available model is configured for ${provider.name}`);
    }

    return { provider, model, auth };
  }

  async configureCustomProvider(
    input: CustomAiProviderConfigInput,
    apiKey?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const customConfigStore = this.customConfigStore;
    if (!customConfigStore) {
      throw new Error("Custom AI provider configuration is unavailable");
    }
    signal?.throwIfAborted();
    const config = normalizeCustomAiProviderConfig(input);
    if (apiKey !== undefined && apiKey.trim().length > 8_192) {
      throw new Error("Custom AI API key is too long");
    }
    const normalizedApiKey = apiKey?.trim() || undefined;

    await this.enqueueCustomConfigMutation(signal, async () => {
      const previousConfig = await customConfigStore.read({ signal });
      const endpointChanged = previousConfig?.baseUrl !== config.baseUrl;
      // Never send a key saved for one gateway to a newly configured gateway.
      // Delete it before publishing the new endpoint so a partial failure leaves
      // the new endpoint unauthenticated rather than leaking the old key.
      if (endpointChanged) {
        await this.credentials.delete(CUSTOM_OPENAI_PROVIDER_ID, { signal });
      }
      await customConfigStore.write(config, { signal });
      if (normalizedApiKey !== undefined) {
        await this.credentials.modify(
          CUSTOM_OPENAI_PROVIDER_ID,
          async () => ({ type: "api_key", key: normalizedApiKey }),
          { signal },
        );
      }
      await this.ensureCustomProvider(signal);
      await this.refreshCustomProvider(signal);
    });
  }

  async removeCustomProvider(signal?: AbortSignal): Promise<void> {
    const customConfigStore = this.customConfigStore;
    if (!customConfigStore) {
      throw new Error("Custom AI provider configuration is unavailable");
    }
    await this.enqueueCustomConfigMutation(signal, async () => {
      signal?.throwIfAborted();
      await customConfigStore.delete({ signal });
      await this.credentials.delete(CUSTOM_OPENAI_PROVIDER_ID, { signal });
      this.models.deleteProvider(CUSTOM_OPENAI_PROVIDER_ID);
      this.customConfig = undefined;
      this.customModelError = undefined;
    });
  }

  async saveApiKey(providerId: string, apiKey: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const key = apiKey.trim();
    if (!key) throw new Error("API key must not be empty");
    if (key.length > 8_192) throw new Error("API key is too long");

    const save = async () => {
      if (providerId === CUSTOM_OPENAI_PROVIDER_ID) await this.ensureCustomProvider(signal);
      const provider = this.models.getProvider(providerId);
      if (!provider) throw new Error(`Unknown AI provider: ${providerId}`);
      if (!provider.auth.apiKey) {
        throw new Error(`${provider.name} does not support API-key authentication`);
      }

      await this.credentials.modify(
        providerId,
        async () => ({
          type: "api_key",
          key,
        }),
        { signal },
      );
    };

    if (providerId === CUSTOM_OPENAI_PROVIDER_ID) {
      await this.enqueueCustomConfigMutation(signal, save);
    } else {
      await save();
    }
  }

  async login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<Credential> {
    const operationController = new AbortController();
    let timedOut = false;
    let cancelled = interaction.signal?.aborted === true;
    const abortFromCaller = () => {
      cancelled = true;
      if (!operationController.signal.aborted) {
        operationController.abort(interaction.signal?.reason);
      }
    };
    if (interaction.signal?.aborted) abortFromCaller();
    else interaction.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const deadline = setTimeout(() => {
      timedOut = true;
      operationController.abort(new Error("AI authentication timed out"));
    }, AI_AUTH_OPERATION_TIMEOUT_MS);

    try {
      return await raceWithAbortSignal(
        this.models.login(providerId, type, {
          ...interaction,
          signal: operationController.signal,
        }),
        operationController.signal,
      );
    } catch (error) {
      if (timedOut) {
        throw new Error(`AI authentication timed out after ${AI_AUTH_OPERATION_TIMEOUT_MS}ms`, {
          cause: error,
        });
      }
      if (cancelled || interaction.signal?.aborted) {
        throw new Error("AI authentication cancelled", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      interaction.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async logout(providerId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const logout = async () => {
      if (providerId === CUSTOM_OPENAI_PROVIDER_ID) await this.ensureCustomProvider(signal);
      if (!this.models.getProvider(providerId)) {
        throw new Error(`Unknown AI provider: ${providerId}`);
      }
      await this.models.logout(providerId, { signal });
    };
    if (providerId === CUSTOM_OPENAI_PROVIDER_ID) {
      await this.enqueueCustomConfigMutation(signal, logout);
    } else {
      await logout();
    }
  }

  private async getSecretValues(providerId?: string): Promise<string[]> {
    const values = AI_AUTH_ENV_VARS.flatMap((name) => {
      const value = process.env[name];
      return value ? [value] : [];
    });
    const providers = providerId
      ? [this.models.getProvider(providerId)].filter((provider): provider is Provider => !!provider)
      : this.models.getProviders();

    await Promise.all(
      providers.map(async (provider) => {
        const credential = await this.credentials.read(provider.id).catch(() => undefined);
        if (!credential) return;
        if (credential.type === "api_key") {
          if (credential.key) values.push(credential.key);
          if (credential.env) values.push(...Object.values(credential.env));
        } else {
          values.push(credential.access, credential.refresh);
          for (const [key, value] of Object.entries(credential)) {
            if (
              key !== "type" &&
              key !== "access" &&
              key !== "refresh" &&
              typeof value === "string"
            ) {
              values.push(value);
            }
          }
        }
      }),
    );
    return values;
  }

  async getSafeErrorMessage(error: unknown): Promise<string> {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
    return redactSensitiveText(message, await this.getSecretValues());
  }

  async runAgent(options: PiAgentRunOptions): Promise<PiAgentRunResult> {
    const operationController = new AbortController();
    let timedOut = false;
    let cancelled = options.signal?.aborted === true;
    let agent: Agent | undefined;
    let unsubscribe: (() => void) | undefined;
    const abortOperation = (reason?: unknown) => {
      if (!operationController.signal.aborted) operationController.abort(reason);
      agent?.abort();
    };
    const onCallerAbort = () => {
      cancelled = true;
      abortOperation(options.signal?.reason);
    };
    if (options.signal?.aborted) onCallerAbort();
    else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const deadline =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            abortOperation(new Error("AI Studio operation timed out"));
          }, options.timeoutMs)
        : undefined;

    let result: unknown;
    const maxToolCalls =
      options.maxToolCalls && options.maxToolCalls > 0
        ? Math.min(Math.floor(options.maxToolCalls), 64)
        : undefined;
    let toolCallCount = 0;

    const resultTool = options.resultTool
      ? {
          ...options.resultTool,
          execute: async (
            toolCallId: string,
            params: any,
            signal?: AbortSignal,
            onUpdate?: any,
          ) => {
            signal?.throwIfAborted();
            result = clone(params);
            return options.resultTool!.execute(toolCallId, params, signal, onUpdate);
          },
        }
      : undefined;
    const tools = [...(options.tools || []), ...(resultTool ? [resultTool] : [])];

    try {
      const resolved = await this.resolveModel(options.providerId, options.modelId, {
        signal: operationController.signal,
      });
      const { provider, model, auth } = resolved;
      operationController.signal.throwIfAborted();

      agent = new Agent({
        initialState: {
          systemPrompt: options.systemPrompt,
          model,
          thinkingLevel: "off",
          tools,
          messages: [],
        },
        // Agent-core 0.84 does not forward maxRetries from AgentOptions to
        // pi-ai. Add the retry policy at this boundary, where the request
        // signal is still available to pi-ai's abortable retry helper.
        streamFn: (streamModel, context, streamOptions) =>
          this.models.streamSimple(streamModel, context, {
            ...streamOptions,
            maxRetries: Math.max(streamOptions?.maxRetries ?? 0, AI_REQUEST_MAX_RETRIES),
            maxRetryDelayMs: Math.min(
              streamOptions?.maxRetryDelayMs ?? AI_REQUEST_MAX_RETRY_DELAY_MS,
              AI_REQUEST_MAX_RETRY_DELAY_MS,
            ),
            ...(provider.id === CUSTOM_OPENAI_PROVIDER_ID
              ? {
                  onPayload: async (payload, payloadModel) => {
                    const replaced = streamOptions?.onPayload
                      ? await streamOptions.onPayload(payload, payloadModel)
                      : payload;
                    return requireToolPayload(replaced ?? payload, !!options.resultTool);
                  },
                }
              : {}),
          }),
        sessionId: options.sessionId || randomUUID(),
        toolExecution: "sequential",
        ...(maxToolCalls
          ? {
              beforeToolCall: async () => {
                if (toolCallCount >= maxToolCalls) {
                  const reason = `AI tool-call budget exceeded (${maxToolCalls})`;
                  abortOperation(new Error(reason));
                  return { block: true, terminate: true, reason };
                }
                toolCallCount++;
                return undefined;
              },
            }
          : {}),
      });

      unsubscribe = agent.subscribe((event) => {
        options.onEvent?.(event);
      });
      await raceWithAbortSignal(agent.prompt(options.prompt), operationController.signal);
      if (timedOut) {
        throw new Error(`AI Studio operation timed out after ${options.timeoutMs}ms`);
      }
      if (cancelled || options.signal?.aborted) {
        throw new Error("AI Studio operation cancelled");
      }

      // A provider response can contain replay content or echoed request data;
      // redact every configured credential, not only the key used for this
      // request, before returning model output to the caller.
      const exactSecrets = await this.getSecretValues();
      const rawResult = result;
      const output =
        rawResult === undefined ? assistantText(agent.state.messages) : JSON.stringify(rawResult);
      if (rawResult === undefined) {
        const failure = agent.state.errorMessage || assistantFailure(agent.state.messages);
        if (failure) {
          throw new Error(`${provider.name} request failed: ${failure}`);
        }
      }
      const safeOutput = redactSensitiveText(output, exactSecrets);
      if (!safeOutput.trim()) {
        throw new Error(`${provider.name} returned no usable response`);
      }

      return {
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        authType: auth.type,
        authSubscription: auth.type === "oauth" && provider.auth.oauth?.isSubscription === true,
        authSource: auth.source,
        output: safeOutput,
        ...(rawResult === undefined ? {} : { result: redactUnknown(rawResult, exactSecrets) }),
      };
    } catch (error) {
      if (timedOut) {
        throw new Error(`AI Studio operation timed out after ${options.timeoutMs}ms`, {
          cause: error,
        });
      }
      if (cancelled || options.signal?.aborted) {
        throw new Error("AI Studio operation cancelled", { cause: error });
      }
      throw error;
    } finally {
      if (deadline) clearTimeout(deadline);
      unsubscribe?.();
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

export function createAiRuntime(
  options: { authPath?: string; customConfigPath?: string } = {},
): AiRuntime {
  const authPath = options.authPath || getAiAuthPath();
  const customConfigPath = options.customConfigPath || getAiConfigPath();
  const credentials = new FileCredentialStore(authPath);
  const customConfig = new FileCustomProviderConfigStore(customConfigPath);
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider());
  models.setProvider(openrouterProvider());
  models.setProvider(opencodeProvider());
  return new PiAiRuntime(models, credentials, customConfig, `${customConfigPath}.transaction`);
}

let defaultRuntime: AiRuntime | undefined;

export function getAiRuntime(): AiRuntime {
  defaultRuntime ??= createAiRuntime();
  return defaultRuntime;
}

function safeAuthUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[REDACTED URL]";
  }
}

/**
 * Browser-oriented auth interaction for local dashboard routes.
 *
 * Pi's provider-owned OAuth implementations open the browser and resolve via
 * their loopback callback. The only interactive choice currently needed by
 * the supported providers is browser vs device-code login; prefer browser
 * here and keep secrets/tokens inside the provider credential store.
 */
export function createBrowserAuthInteraction(signal?: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt: AuthPrompt): Promise<string> {
      signal?.throwIfAborted();
      prompt.signal?.throwIfAborted();
      if (prompt.type === "select") {
        const browser = prompt.options.find((option) => option.id === "browser");
        const first = browser || prompt.options[0];
        if (!first) throw new Error("Authentication offered no login methods");
        return first.id;
      }
      if (prompt.type === "manual_code") {
        // OpenRouter races this prompt against its loopback callback. Keep the
        // manual branch pending so a successful browser callback wins instead
        // of being reported as an authentication failure.
        return new Promise<string>((_resolve, reject) => {
          let settled = false;
          const promptSignals = [prompt.signal, signal].filter(
            (candidate, index, all): candidate is AbortSignal =>
              !!candidate && all.indexOf(candidate) === index,
          );
          const cleanup = () => {
            for (const promptSignal of promptSignals) {
              promptSignal.removeEventListener("abort", cancel);
            }
          };
          const cancel = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("Browser authentication cancelled"));
          };
          if (promptSignals.some((promptSignal) => promptSignal.aborted)) {
            cancel();
          } else {
            for (const promptSignal of promptSignals) {
              promptSignal.addEventListener("abort", cancel, { once: true });
            }
          }
        });
      }
      throw new Error("This provider requires interactive terminal input");
    },
    notify(event: AuthEvent): void {
      if (event.type === "auth_url") {
        if (process.env.VIBE_REPLAY_NO_AUTO_OPEN !== "1") {
          void open(event.url).catch(() => {});
        }
        if (process.env.VIBE_REPLAY_DEBUG) {
          console.error(`[vibe-replay] Open ${safeAuthUrlForLog(event.url)} to complete AI login`);
        }
      } else if (event.type === "device_code" && process.env.VIBE_REPLAY_DEBUG) {
        console.error(
          `[vibe-replay] Open ${safeAuthUrlForLog(event.verificationUri)} and complete AI login`,
        );
      } else if (event.type === "info" && process.env.VIBE_REPLAY_DEBUG) {
        console.error(`[vibe-replay] ${redactSensitiveText(event.message)}`);
      } else if (event.type === "progress" && process.env.VIBE_REPLAY_DEBUG) {
        console.error(`[vibe-replay] ${redactSensitiveText(event.message)}`);
      }
    },
  };
}
