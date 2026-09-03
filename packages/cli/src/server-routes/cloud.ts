import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthSession } from "../server-auth.js";
import { getErrorMessage } from "../server-core.js";

interface CloudProxyRouteDeps {
  fetchCloudApiWithLocalAuth: AuthSession["fetchCloudApiWithLocalAuth"];
}

/** Shared response handler for cloud API proxy routes (BFF mode). */
async function proxyCloudResponse(
  c: Context,
  fetchCloudApiWithLocalAuth: CloudProxyRouteDeps["fetchCloudApiWithLocalAuth"],
  cloudPath: string,
  errorLabel: string,
  init?: RequestInit,
) {
  try {
    const proxied = await fetchCloudApiWithLocalAuth(cloudPath, init);
    if (proxied.unauthorized) return c.json({ error: "Unauthorized" }, 401);
    const contentType = proxied.response.headers.get("content-type") || "";
    const status = proxied.response.status as ContentfulStatusCode;
    if (!contentType.includes("application/json")) {
      const text = await proxied.response.text();
      return c.body(text, status, { "Content-Type": contentType || "text/plain" });
    }
    const data = await proxied.response.json().catch(() => ({}));
    return c.json(data, status);
  } catch (err) {
    return c.json({ error: `${errorLabel}: ${getErrorMessage(err)}` }, 502);
  }
}

/** Proxy cloud replay, file, and gist APIs through the local auth session. */
export function registerCloudProxyRoutes(app: Hono, deps: CloudProxyRouteDeps): void {
  const { fetchCloudApiWithLocalAuth } = deps;

  app.get("/api/cloud-replays", async (c) => {
    return proxyCloudResponse(
      c,
      fetchCloudApiWithLocalAuth,
      "/api/cloud-replays",
      "Cloud API unavailable",
    );
  });

  app.post("/api/cloud-replays", async (c) => {
    const body = await c.req.text();
    return proxyCloudResponse(
      c,
      fetchCloudApiWithLocalAuth,
      "/api/cloud-replays",
      "Cloud upload failed",
      {
        method: "POST",
        headers: { "Content-Type": c.req.header("content-type") || "application/json" },
        body,
      },
    );
  });

  app.delete("/api/cloud-replays/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
      return c.json({ error: "Invalid replay ID" }, 400);
    }
    return proxyCloudResponse(
      c,
      fetchCloudApiWithLocalAuth,
      `/api/cloud-replays/${id}`,
      "Cloud delete failed",
      {
        method: "DELETE",
      },
    );
  });

  app.post("/api/files", async (c) => {
    const body = await c.req.text();
    return proxyCloudResponse(c, fetchCloudApiWithLocalAuth, "/api/files", "File upload failed", {
      method: "POST",
      headers: { "Content-Type": c.req.header("content-type") || "application/json" },
      body,
    });
  });

  app.get("/api/files", async (c) => {
    return proxyCloudResponse(c, fetchCloudApiWithLocalAuth, "/api/files", "File list failed");
  });

  app.delete("/api/files/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
      return c.json({ error: "Invalid file ID" }, 400);
    }
    return proxyCloudResponse(
      c,
      fetchCloudApiWithLocalAuth,
      `/api/files/${id}`,
      "File delete failed",
      {
        method: "DELETE",
      },
    );
  });

  app.post("/api/gists", async (c) => {
    const body = await c.req.text();
    return proxyCloudResponse(c, fetchCloudApiWithLocalAuth, "/api/gists", "Gist publish failed", {
      method: "POST",
      headers: { "Content-Type": c.req.header("content-type") || "application/json" },
      body,
    });
  });

  app.patch("/api/gists/:gistId", async (c) => {
    const gistId = c.req.param("gistId");
    if (!/^[a-f0-9]{20,40}$/.test(gistId)) {
      return c.json({ error: "Invalid gist ID" }, 400);
    }
    const body = await c.req.text();
    return proxyCloudResponse(
      c,
      fetchCloudApiWithLocalAuth,
      `/api/gists/${gistId}`,
      "Gist update failed",
      {
        method: "PATCH",
        headers: { "Content-Type": c.req.header("content-type") || "application/json" },
        body,
      },
    );
  });
}
