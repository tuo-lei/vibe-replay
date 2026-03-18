import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

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
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        scope: ["read:user", "user:email", "gist"],
      },
    },
    emailAndPassword: { enabled: false },
    account: {
      encryptOAuthTokens: true,
    },
    trustedOrigins,
  });
}
