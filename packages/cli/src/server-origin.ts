import type { Context } from "hono";

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

  const trustedDevProxy =
    process.env.VIBE_REPLAY_DEV_MENU === "1" &&
    c.req.header("x-vibe-replay-dev-proxy") === "1" &&
    (!fetchSite || fetchSite === "same-origin" || fetchSite === "none");
  if (origin) {
    try {
      const requestOrigin = new URL(origin);
      const apiOrigin = new URL(c.req.url);
      if (!equivalentLocalOrigin(requestOrigin, apiOrigin) && !trustedDevProxy) return false;
    } catch {
      return false;
    }
  }
  return true;
}
