import { betterAuth } from "better-auth";

export type AuthEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
};

/**
 * Create a Better Auth instance per request.
 * D1 binding is only available inside request context,
 * so we must instantiate auth on each request.
 */
export function createAuth(env: AuthEnv) {
  const isDev = env.BETTER_AUTH_URL.startsWith("http://localhost");
  const trustedOrigins = ["https://vibe-replay.com"];
  if (isDev) {
    trustedOrigins.push("http://localhost:8787", "http://localhost:4321", "http://localhost:5173");
  }
  return betterAuth({
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    emailAndPassword: { enabled: false },
    account: {
      encryptOAuthTokens: true,
    },
    trustedOrigins,
  });
}
