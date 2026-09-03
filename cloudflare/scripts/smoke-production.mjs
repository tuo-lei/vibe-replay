const baseUrl = (process.env.VIBE_REPLAY_SMOKE_URL || "https://vibe-replay.com").replace(/\/$/, "");

async function fetchWithRetry(path, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await fetch(`${baseUrl}${path}`, init);
      if (response.status < 500 || attempt === 8) return response;
    } catch (error) {
      lastError = error;
      if (attempt === 8) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw lastError || new Error(`Request failed: ${path}`);
}

async function expectJson(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: expected a JSON response`);
  }
}

const session = await fetchWithRetry("/api/auth/get-session");
await expectJson(session, 200, "get-session");

const oauthStart = await fetchWithRetry("/api/auth/sign-in/social", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: baseUrl,
  },
  body: JSON.stringify({ provider: "github", callbackURL: "/auth/success" }),
});
const oauthBody = await expectJson(oauthStart, 200, "social sign-in");
const oauthUrl = typeof oauthBody?.url === "string" ? new URL(oauthBody.url) : null;
if (
  oauthBody?.redirect !== true ||
  oauthUrl?.hostname !== "github.com" ||
  oauthUrl?.pathname !== "/login/oauth/authorize"
) {
  throw new Error("social sign-in did not return a GitHub authorization redirect");
}

for (const path of ["/api/cloud-replays", "/api/files"]) {
  const response = await fetchWithRetry(path);
  if (response.status !== 401) {
    throw new Error(`${path}: expected HTTP 401 without a session, got ${response.status}`);
  }
}

console.log(`Production API smoke passed: ${baseUrl}`);
