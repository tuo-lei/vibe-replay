import type { Context, Hono } from "hono";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** Treat loopback aliases as the same local host, but preserve port isolation. */
function equivalentLocalOrigin(left: URL, right: URL): boolean {
  if (left.protocol !== right.protocol || left.port !== right.port) return false;
  return (
    left.hostname === right.hostname ||
    (isLoopbackHostname(left.hostname) && isLoopbackHostname(right.hostname))
  );
}

/** Accept only same-origin browser requests, including the trusted Vite proxy marker. */
export function isSameOriginSettingsRequest(c: Context): boolean {
  const origin = c.req.header("Origin");
  const fetchSite = c.req.header("Sec-Fetch-Site");
  const fetchSiteAllowed =
    !fetchSite || fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";
  if (!fetchSiteAllowed) return false;

  let apiOrigin: URL;
  try {
    apiOrigin = new URL(c.req.url);
  } catch {
    return false;
  }
  // A DNS-rebinding host can match its own Origin while still reaching the
  // loopback listener. Only loopback request URLs are valid local API origins.
  if (!isLoopbackHostname(apiOrigin.hostname)) return false;

  const trustedDevProxy =
    process.env.VIBE_REPLAY_DEV_MENU === "1" &&
    c.req.header("x-vibe-replay-dev-proxy") === "1" &&
    (!fetchSite || fetchSite === "same-origin" || fetchSite === "none");
  if (origin) {
    try {
      const requestOrigin = new URL(origin);
      if (!equivalentLocalOrigin(requestOrigin, apiOrigin) && !trustedDevProxy) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Protect every mutating local API route from cross-site requests.
 *
 * The dashboard server is intentionally unauthenticated and listens on
 * loopback, so a malicious web page could otherwise issue CSRF requests to a
 * known dashboard port and mutate or delete local replay data. Read-only GETs
 * remain available to support the dashboard's normal loading flow.
 */
export function registerSameOriginMutationGuard(app: Hono): void {
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    const mutating =
      method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    if (mutating && !isSameOriginSettingsRequest(c)) {
      return c.json({ error: "API requests must be same-origin" }, 403);
    }
    return next();
  });
}
