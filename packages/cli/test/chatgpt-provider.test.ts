import { describe, expect, it, vi } from "vitest";
import {
  buildChatGptAuthorizeUrl,
  CHATGPT_PROVIDER_ID,
  chatgptPlanProvider,
  mapChatGptModels,
  revokeChatGptSession,
  sanitizeChatGptPlanPayload,
} from "../src/chatgpt-provider.js";

describe("ChatGPT plan provider", () => {
  it("builds first-time dynamic registration with plan-usage scopes", () => {
    const url = new URL(
      buildChatGptAuthorizeUrl({
        clientId: "dynamic_agent_client",
        hostId: "urn:uuid:11111111-2222-4333-8444-555555555555",
        redirectUri: "http://127.0.0.1:54321/auth/callback",
        state: "state-value",
        nonce: "nonce-value",
        challenge: "pkce-challenge",
        newRegistration: true,
      }),
    );

    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("Vibe Replay");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(
      "urn:uuid:11111111-2222-4333-8444-555555555555",
    );
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/auth/callback");
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(
      new Set([
        "openid",
        "profile",
        "email",
        "offline_access",
        "resource.invoke",
        "chatgpt.tokens.use.direct",
      ]),
    );
    expect(url.searchParams.has("id_token_hint")).toBe(false);
  });

  it("reuses an issued client id and account hints without registering again", () => {
    const url = new URL(
      buildChatGptAuthorizeUrl({
        clientId: "oaiapp_saved",
        hostId: "urn:uuid:11111111-2222-4333-8444-555555555555",
        redirectUri: "http://127.0.0.1:54321/auth/callback",
        state: "state-value",
        nonce: "nonce-value",
        challenge: "pkce-challenge",
        newRegistration: false,
        idTokenHint: "header.payload.signature",
        loginHint: "person@example.com",
      }),
    );

    expect(url.searchParams.get("client_id")).toBe("oaiapp_saved");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.get("id_token_hint")).toBe("header.payload.signature");
    expect(url.searchParams.get("login_hint")).toBe("person@example.com");
  });

  it("keeps only account-visible models in server order", () => {
    const models = mapChatGptModels({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
        { slug: "internal-model", display_name: "Internal", visibility: "hidden" },
        { slug: "gpt-6.1-fast", display_name: "GPT-6.1 Fast", visibility: "list" },
        { slug: "gpt-6.1-sol", display_name: "Duplicate", visibility: "list" },
      ],
    });

    expect(models.map((model) => [model.id, model.name])).toEqual([
      ["gpt-6.1-sol", "GPT-6.1 Sol"],
      ["gpt-6.1-fast", "GPT-6.1 Fast"],
    ]);
    expect(models.every((model) => model.provider === CHATGPT_PROVIDER_ID)).toBe(true);
    expect(models.every((model) => model.api === "openai-responses")).toBe(true);
  });

  it("sanitizes Responses requests for the current plan-usage preview", () => {
    const payload = sanitizeChatGptPlanPayload({
      model: "gpt-6.1-sol",
      stream: false,
      store: true,
      max_output_tokens: 1234,
      temperature: 0.2,
      previous_response_id: "resp_old",
      prompt_cache_retention: "24h",
      input: [
        { role: "system", content: "Follow the app instructions." },
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
      tools: [{ type: "function", name: "answer" }],
    }) as Record<string, unknown>;

    expect(payload.stream).toBe(true);
    expect(payload.store).toBe(false);
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("previous_response_id");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
    expect(payload.tools).toEqual([{ type: "function", name: "answer" }]);
    expect(payload.input).toEqual([
      { role: "developer", content: "Follow the app instructions." },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  it("exposes ChatGPT as a distinct subscription-backed provider", () => {
    const provider = chatgptPlanProvider({
      statePath: "/tmp/vibe-replay-chatgpt-provider-test.json",
    });
    expect(provider.id).toBe("chatgpt");
    expect(provider.name).toBe("ChatGPT");
    expect(provider.baseUrl).toBe("https://api.openai.com/v1");
    expect(provider.auth.oauth?.loginLabel).toBe("Continue with ChatGPT");
    expect(provider.auth.oauth?.isSubscription).toBe(true);
  });

  it("revokes the renewable ChatGPT session with the issued client id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await revokeChatGptSession({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        clientId: "oaiapp_saved",
        idToken: "header.payload.signature",
        scopes: ["chatgpt.tokens.use.direct"],
        subject: "subject-1",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, request] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://auth.openai.com/api/accounts/oauth/revoke");
      expect(request?.method).toBe("POST");
      const body = request?.body as URLSearchParams;
      expect(body.get("token")).toBe("refresh-token");
      expect(body.get("token_type_hint")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("oaiapp_saved");
    } finally {
      fetchMock.mockRestore();
    }
  });
});
