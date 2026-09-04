import type { Hono } from "hono";
import { saveAuthToken } from "../publishers/cloud.js";
import type { AuthSession } from "../server-auth.js";
import { recordTelemetry } from "../telemetry.js";

interface AuthRouteDeps {
  cloudApiBaseUrl: string;
  readLocalAuthSession: AuthSession["readLocalAuthSession"];
  isAuthValid: AuthSession["isAuthValid"];
  clearLocalAuthSession: AuthSession["clearLocalAuthSession"];
  /** Fire-and-forget insights sync, run after a successful login. */
  autoSyncInsights: () => Promise<void>;
}

/** Local auth routes — status, session, logout, and the CLI OAuth login flow. */
export function registerAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  const {
    cloudApiBaseUrl,
    readLocalAuthSession,
    isAuthValid,
    clearLocalAuthSession,
    autoSyncInsights,
  } = deps;

  app.get("/api/auth/status", async (c) => {
    const auth = readLocalAuthSession();
    if (!auth) return c.json({ authenticated: false, user: null });
    const valid = await isAuthValid();
    if (!valid) return c.json({ authenticated: false, user: null });
    return c.json({ authenticated: true, user: auth.user || null });
  });

  // Better Auth-shaped local session endpoint for editor mode parity.
  app.get("/api/auth/get-session", async (c) => {
    const auth = readLocalAuthSession();
    if (!auth) return c.json({ session: null, user: null });
    const valid = await isAuthValid();
    if (!valid) return c.json({ session: null, user: null });
    return c.json({
      session: { token: auth.token },
      user: auth.user,
    });
  });

  app.post("/api/auth/logout", async (c) => {
    await clearLocalAuthSession();
    return c.json({ success: true });
  });

  // Alias for cloud worker parity; keep /api/auth/logout for backward compatibility
  app.post("/api/auth/sign-out", async (c) => {
    await clearLocalAuthSession();
    return c.json({ success: true });
  });

  // Auth login — start OAuth flow, return URL for browser to open
  app.post("/api/auth/login", async (c) => {
    const { randomUUID } = await import("node:crypto");
    const http = await import("node:http");

    const apiUrl = cloudApiBaseUrl;
    const nonce = randomUUID();

    // Start a temporary localhost server to receive the OAuth callback
    return new Promise<Response>((resolveResponse) => {
      let responded = false;
      const respond = (r: Response) => {
        if (responded) return;
        responded = true;
        resolveResponse(r);
      };

      const server = http.createServer((req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(200, {
            "Access-Control-Allow-Origin": apiUrl,
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method === "POST" && req.url === "/callback") {
          let body = "";
          let destroyed = false;
          req.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 1_000_000) {
              destroyed = true;
              res.writeHead(413);
              res.end();
              req.destroy();
            }
          });
          req.on("end", async () => {
            if (destroyed) return;
            try {
              const data = JSON.parse(body);
              if (data.nonce !== nonce) {
                res.writeHead(403);
                res.end("Forbidden");
                server.close();
                return;
              }
              res.writeHead(200, {
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": apiUrl,
              });
              res.end("OK");

              // Save auth keyed by current API environment
              await saveAuthToken({ token: data.token, user: data.user }, cloudApiBaseUrl);
              recordTelemetry("auth.login");

              // Auto-sync insights to cloud after login (fire-and-forget)
              autoSyncInsights().catch(() => {});
            } catch {
              res.writeHead(400);
              res.end("Bad Request");
            }
            server.close();
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      server.on("error", (err) => {
        respond(c.json({ error: `OAuth server failed: ${err.message}` }, 500));
        // Close the server so a post-listen error doesn't leak until the 5-minute timeout
        try {
          server.close();
        } catch {
          /* already closed */
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          respond(c.json({ error: "Failed to get server address" }, 500));
          return;
        }
        const loginUrl = `${apiUrl}/auth/cli-login?port=${addr.port}&nonce=${nonce}`;
        respond(c.json({ url: loginUrl }));
      });

      // Timeout after 5 minutes
      setTimeout(
        () => {
          server.close();
        },
        5 * 60 * 1000,
      );
    });
  });
}
