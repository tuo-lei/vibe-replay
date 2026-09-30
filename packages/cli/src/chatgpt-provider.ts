import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  createProvider,
  type CredentialStore,
  type Model,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export const CHATGPT_PROVIDER_ID = "chatgpt";

const APP_NAME = "Vibe Replay";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AUTHORIZATION_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REVOCATION_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const RESPONSES_BASE_URL = "https://api.openai.com/v1";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const CHATGPT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;
const SHARING_SCOPE = "chatgpt.tokens.use.direct";
const DEFAULT_STATE_PATH = join(homedir(), ".vibe-replay", "chatgpt-registration.json");
const remoteJwks = createRemoteJWKSet(new URL(JWKS_URL));

type JsonRecord = Record<string, unknown>;

interface ChatGptRegistration {
  clientId: string;
  subject?: string;
  email?: string;
}

interface ChatGptRegistrationState {
  version: 1;
  hostId: string;
  registration?: ChatGptRegistration;
}

interface ChatGptOAuthCredential extends OAuthCredential {
  clientId: string;
  idToken: string;
  scopes: string[];
  subject: string;
  email?: string;
}

interface ChatGptProviderOptions {
  credentialStore?: CredentialStore;
  statePath?: string;
}

interface OAuthCallback {
  code: string;
  state: string;
  clientId?: string;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  idToken?: string;
  scopes?: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32);
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

function parseRegistrationState(value: unknown): ChatGptRegistrationState | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.hostId !== "string") return undefined;
  if (!value.hostId.startsWith("urn:uuid:")) return undefined;
  if (value.registration === undefined) return { version: 1, hostId: value.hostId };
  if (!isRecord(value.registration) || typeof value.registration.clientId !== "string") {
    return undefined;
  }
  return {
    version: 1,
    hostId: value.hostId,
    registration: {
      clientId: value.registration.clientId,
      ...(typeof value.registration.subject === "string"
        ? { subject: value.registration.subject }
        : {}),
      ...(typeof value.registration.email === "string" ? { email: value.registration.email } : {}),
    },
  };
}

class RegistrationStore {
  constructor(private readonly filePath: string) {}

  private async write(value: ChatGptRegistrationState): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async read(): Promise<ChatGptRegistrationState | undefined> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new Error(`Invalid ChatGPT registration file: ${this.filePath}`);
    }
    const state = parseRegistrationState(parsed);
    if (!state) throw new Error(`Invalid ChatGPT registration file: ${this.filePath}`);
    return state;
  }

  async ensureHost(): Promise<ChatGptRegistrationState> {
    const existing = await this.read();
    if (existing) return existing;
    const created: ChatGptRegistrationState = {
      version: 1,
      hostId: `urn:uuid:${randomUUID()}`,
    };
    await this.write(created);
    return (await this.read()) ?? created;
  }

  async saveRegistration(hostId: string, registration: ChatGptRegistration): Promise<void> {
    await this.write({ version: 1, hostId, registration });
  }

  async clearRegistration(): Promise<void> {
    const current = await this.read();
    if (!current) return;
    await this.write({ version: 1, hostId: current.hostId });
  }
}

function sendCallbackPage(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Vibe Replay</title></head>` +
      `<body><p>${message}</p></body></html>`,
  );
}

async function startCallbackServer(signal: AbortSignal): Promise<{
  redirectUri: string;
  wait: () => Promise<OAuthCallback>;
  close: () => void;
}> {
  signal.throwIfAborted();
  let resolveCallback: (value: OAuthCallback) => void = () => {};
  let rejectCallback: (error: Error) => void = () => {};
  const callback = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  let settled = false;
  const server = createServer((request, response) => {
    if (settled) {
      sendCallbackPage(response, 409, "This sign-in callback has already been used.");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${CALLBACK_HOST}`);
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      sendCallbackPage(response, 404, "Sign-in callback not found.");
      return;
    }
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      settled = true;
      const description = url.searchParams.get("error_description") || oauthError;
      sendCallbackPage(response, 400, "ChatGPT authorization was not completed.");
      rejectCallback(new Error(`ChatGPT authorization failed: ${description}`));
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      sendCallbackPage(response, 400, "ChatGPT returned an incomplete authorization response.");
      return;
    }
    settled = true;
    sendCallbackPage(response, 200, "Connected to ChatGPT. You can close this window.");
    resolveCallback({ code, state, clientId: url.searchParams.get("client_id") || undefined });
  });

  const closeServer = () => server.close();
  const onAbort = () => {
    if (!settled) {
      settled = true;
      rejectCallback(new Error("ChatGPT sign-in cancelled"));
    }
    closeServer();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, CALLBACK_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    closeServer();
    throw error;
  }
  signal.throwIfAborted();
  const address = server.address();
  if (!address || typeof address === "string") {
    signal.removeEventListener("abort", onAbort);
    closeServer();
    throw new Error("Could not determine the ChatGPT callback port");
  }
  const redirectUri = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;
  return {
    redirectUri,
    wait: async () => {
      try {
        return await callback;
      } finally {
        signal.removeEventListener("abort", onAbort);
        closeServer();
      }
    },
    close: () => {
      signal.removeEventListener("abort", onAbort);
      closeServer();
    },
  };
}

export function buildChatGptAuthorizeUrl(input: {
  clientId: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  newRegistration: boolean;
  idTokenHint?: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CHATGPT_SCOPES.join(" "));
  url.searchParams.set("resource", RESOURCE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("ext_agent_host_id", input.hostId);
  if (input.newRegistration) {
    url.searchParams.set("agent_name_hint", APP_NAME);
  } else {
    if (input.idTokenHint) url.searchParams.set("id_token_hint", input.idTokenHint);
    if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  }
  return url.toString();
}

async function parseTokenResponse(
  response: Response,
  requireIdToken: boolean,
): Promise<TokenResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new Error(`ChatGPT OAuth token request failed (HTTP ${response.status})`);
  }
  if (!isRecord(body)) throw new Error("ChatGPT OAuth returned invalid JSON");
  const accessToken = stringField(body.access_token);
  const refreshToken = stringField(body.refresh_token);
  const idToken = stringField(body.id_token);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("ChatGPT OAuth token response is missing required fields");
  }
  if (requireIdToken && !idToken) {
    throw new Error("ChatGPT OAuth token response is missing the ID token");
  }
  return {
    accessToken,
    refreshToken,
    expiresIn,
    ...(idToken ? { idToken } : {}),
    ...(typeof body.scope === "string" ? { scopes: body.scope.split(/\s+/).filter(Boolean) } : {}),
  };
}

async function exchangeAuthorizationCode(input: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  signal: AbortSignal;
}): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: RESOURCE,
    }),
    signal: input.signal,
  });
  return parseTokenResponse(response, true);
}

async function validateIdentity(
  idToken: string,
  clientId: string,
  nonce: string,
): Promise<{ subject: string; email?: string }> {
  const { payload } = await jwtVerify(idToken, remoteJwks, {
    issuer: ISSUER,
    audience: clientId,
  });
  if (payload.nonce !== nonce) throw new Error("ChatGPT ID token nonce mismatch");
  if (!payload.sub) throw new Error("ChatGPT ID token has no subject");
  return {
    subject: payload.sub,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
  };
}

async function validateRefreshedIdentity(
  idToken: string,
  clientId: string,
  expectedSubject: string,
): Promise<void> {
  const { payload } = await jwtVerify(idToken, remoteJwks, {
    issuer: ISSUER,
    audience: clientId,
  });
  if (!payload.sub || payload.sub !== expectedSubject) {
    throw new Error("ChatGPT refreshed ID token does not match the connected account");
  }
}

function asChatGptCredential(value: unknown): ChatGptOAuthCredential | undefined {
  if (!isRecord(value) || value.type !== "oauth") return undefined;
  const access = stringField(value.access);
  const refresh = stringField(value.refresh);
  const clientId = stringField(value.clientId);
  const idToken = stringField(value.idToken);
  const subject = stringField(value.subject);
  if (
    !access ||
    !refresh ||
    !clientId ||
    !idToken ||
    !subject ||
    typeof value.expires !== "number" ||
    !Array.isArray(value.scopes)
  ) {
    return undefined;
  }
  const scopes = value.scopes.filter((scope): scope is string => typeof scope === "string");
  return {
    type: "oauth",
    access,
    refresh,
    expires: value.expires,
    clientId,
    idToken,
    scopes,
    subject,
    ...(typeof value.email === "string" ? { email: value.email } : {}),
  };
}

async function loginWithChatGpt(
  interaction: ProviderAuthInteraction,
  store: RegistrationStore,
  credentialStore?: CredentialStore,
): Promise<ChatGptOAuthCredential> {
  const saved = await store.ensureHost();
  const registration = saved.registration;
  const previousCredential = credentialStore
    ? asChatGptCredential(
        await credentialStore.read(CHATGPT_PROVIDER_ID, { signal: interaction.signal }),
      )
    : undefined;
  const previousForRegistration =
    previousCredential?.clientId === registration?.clientId ? previousCredential : undefined;
  const newRegistration = !registration?.clientId;
  const clientId = registration?.clientId || DYNAMIC_CLIENT_ID;
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const { verifier, challenge } = await pkce();
  const callback = await startCallbackServer(interaction.signal);

  try {
    const authUrl = buildChatGptAuthorizeUrl({
      clientId,
      hostId: saved.hostId,
      redirectUri: callback.redirectUri,
      state,
      nonce,
      challenge,
      newRegistration,
      idTokenHint: previousForRegistration?.idToken,
      loginHint: registration?.email,
    });
    interaction.notify({
      type: "auth_url",
      url: authUrl,
      instructions: "Continue with ChatGPT in your browser, then return to Vibe Replay.",
    });
    const returned = await callback.wait();
    if (returned.state !== state) throw new Error("ChatGPT OAuth state mismatch");

    let issuedClientId = registration?.clientId;
    if (newRegistration) {
      if (!returned.clientId || returned.clientId === DYNAMIC_CLIENT_ID) {
        throw new Error("ChatGPT registration did not return an issued client ID");
      }
      issuedClientId = returned.clientId;
      // Dynamic registration requires retaining the issued id before the
      // one-time authorization code is exchanged.
      await store.saveRegistration(saved.hostId, { clientId: issuedClientId });
    } else if (returned.clientId && returned.clientId !== issuedClientId) {
      throw new Error("ChatGPT returned a different client ID for this saved registration");
    }
    if (!issuedClientId) throw new Error("ChatGPT registration is incomplete");

    interaction.notify({ type: "progress", message: "Finishing ChatGPT sign-in…" });
    const token = await exchangeAuthorizationCode({
      clientId: issuedClientId,
      code: returned.code,
      verifier,
      redirectUri: callback.redirectUri,
      signal: interaction.signal,
    });
    if (!token.idToken) throw new Error("ChatGPT sign-in returned no ID token");
    const scopes = token.scopes || [];
    if (!scopes.includes(SHARING_SCOPE)) {
      throw new Error(
        "ChatGPT plan usage was not granted. Reconnect and allow Vibe Replay to use your ChatGPT plan.",
      );
    }
    const identity = await validateIdentity(token.idToken, issuedClientId, nonce);
    if (registration?.subject && identity.subject !== registration.subject) {
      throw new Error("ChatGPT account does not match this saved registration");
    }
    await store.saveRegistration(saved.hostId, {
      clientId: issuedClientId,
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
    });
    return {
      type: "oauth",
      access: token.accessToken,
      refresh: token.refreshToken,
      expires: Date.now() + token.expiresIn * 1000,
      clientId: issuedClientId,
      idToken: token.idToken,
      scopes,
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
    };
  } finally {
    callback.close();
  }
}

async function refreshChatGptCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<ChatGptOAuthCredential> {
  const current = asChatGptCredential(credential);
  if (!current) throw new Error("Saved ChatGPT credential is incomplete; sign in again");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: current.clientId,
      refresh_token: current.refresh,
      resource: RESOURCE,
    }),
    signal,
  });
  const token = await parseTokenResponse(response, false);
  const scopes = token.scopes || current.scopes;
  if (!scopes.includes(SHARING_SCOPE)) {
    throw new Error("ChatGPT plan usage is no longer enabled for this connection");
  }
  if (token.idToken) {
    await validateRefreshedIdentity(token.idToken, current.clientId, current.subject);
  }
  return {
    ...current,
    access: token.accessToken,
    refresh: token.refreshToken,
    expires: Date.now() + token.expiresIn * 1000,
    scopes,
    ...(token.idToken ? { idToken: token.idToken } : {}),
  };
}

export async function resetChatGptRegistration(statePath = DEFAULT_STATE_PATH): Promise<void> {
  await new RegistrationStore(statePath).clearRegistration();
}

export async function revokeChatGptSession(
  credential: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const current = asChatGptCredential(credential);
  if (!current) throw new Error("Saved ChatGPT credential is incomplete; sign in again");
  const response = await fetch(REVOCATION_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: current.refresh,
      token_type_hint: "refresh_token",
      client_id: current.clientId,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`ChatGPT session revocation failed (HTTP ${response.status})`);
  }
}

function modelFromCatalog(value: unknown): Model<"openai-responses"> | undefined {
  if (!isRecord(value) || value.visibility !== "list") return undefined;
  const slug = stringField(value.slug);
  if (!slug || slug.length > 256 || /[\r\n]/.test(slug)) return undefined;
  const displayName = stringField(value.display_name) || slug;
  return {
    id: slug,
    name: displayName.slice(0, 256),
    api: "openai-responses",
    provider: CHATGPT_PROVIDER_ID,
    baseUrl: RESPONSES_BASE_URL,
    // The account catalog does not expose per-model reasoning capabilities.
    // Keep the generic runtime conservative; the payload sanitizer below
    // converts Pi's system message to the required developer role.
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

export function mapChatGptModels(payload: unknown): Model<"openai-responses">[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("ChatGPT model catalog returned an invalid response");
  }
  const seen = new Set<string>();
  const models: Model<"openai-responses">[] = [];
  for (const value of payload.models) {
    const model = modelFromCatalog(value);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) throw new Error("ChatGPT account has no available AI models");
  return models;
}

async function fetchChatGptModels(
  credential: OAuthCredential | undefined,
  signal: AbortSignal,
): Promise<Model<"openai-responses">[]> {
  const current = asChatGptCredential(credential);
  if (!current) throw new Error("Sign in with ChatGPT before loading models");
  const response = await fetch(`${RESPONSES_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${current.access}` },
    signal,
  });
  if (!response.ok) throw new Error(`ChatGPT model catalog failed (HTTP ${response.status})`);
  return mapChatGptModels(await response.json());
}

const UNSUPPORTED_PLAN_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

/** Enforce the current Sign in with ChatGPT plan-usage Responses contract. */
export function sanitizeChatGptPlanPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const next: JsonRecord = { ...payload, store: false, stream: true };
  for (const field of UNSUPPORTED_PLAN_FIELDS) delete next[field];
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) =>
      isRecord(item) && item.role === "system" ? { ...item, role: "developer" } : item,
    );
  }
  return next;
}

export function chatgptPlanProvider(
  options: ChatGptProviderOptions = {},
): Provider<"openai-responses"> {
  const store = new RegistrationStore(options.statePath || DEFAULT_STATE_PATH);
  return createProvider({
    id: CHATGPT_PROVIDER_ID,
    name: "ChatGPT",
    baseUrl: RESPONSES_BASE_URL,
    auth: {
      oauth: {
        name: "ChatGPT plan",
        loginLabel: "Continue with ChatGPT",
        isSubscription: true,
        login: (interaction) => loginWithChatGpt(interaction, store, options.credentialStore),
        refresh: refreshChatGptCredential,
        async toAuth(credential) {
          const current = asChatGptCredential(credential);
          if (!current) throw new Error("Saved ChatGPT credential is incomplete; sign in again");
          return { apiKey: current.access };
        },
      },
    },
    models: [],
    fetchModels: ({ credential, signal }) =>
      fetchChatGptModels(credential as OAuthCredential | undefined, signal),
    api: openAIResponsesApi(),
  });
}
