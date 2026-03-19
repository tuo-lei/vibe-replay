import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export const PROD_ORIGINS = ["https://vibe-replay.com"];
export const DEV_ORIGINS = [
  "http://localhost:8787",
  "http://localhost:4321",
  "http://localhost:5173",
];

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
  // Trust production origins. In production, also trust localhost for CLI dashboard
  // (CLI uses random ports, CORS middleware handles the actual origin validation)
  const trustedOrigins = [...PROD_ORIGINS];
  // Always trust localhost — CLI dashboard runs on random ports
  trustedOrigins.push("http://localhost");
  if (isDev) {
    trustedOrigins.push(...DEV_ORIGINS);
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
