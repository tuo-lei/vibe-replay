import type { Context, Hono } from "hono";
import { createBrowserAuthInteraction, getAiRuntime } from "../ai-runtime.js";
import { generateFeedback, generateToneAdjustment, generateTranslation } from "../feedback.js";
import { loadOverlays, sessionWithEffectiveContent } from "../overlays.js";
import { resolveAiSelection, resolveDefaultAiSelection } from "../server-ai-selection.js";
import { saveAnnotations, saveOverlays } from "../server-persistence.js";
import { requireSlug, safeTargetId } from "../server-core.js";
import type { ReplaySession, SceneOverlay, SessionOverlays } from "../types.js";

interface AiRouteDeps {
  baseDir: string;
  loadSession: (slug: string, targetId?: string) => Promise<ReplaySession>;
  isSameOriginSettingsRequest: (c: Context) => boolean;
}

function fixOriginalValues(overlays: SceneOverlay[], originalSession: ReplaySession): void {
  for (const overlay of overlays) {
    const scene = originalSession.scenes[overlay.sceneIndex];
    if (scene && (scene.type === "user-prompt" || scene.type === "text-response")) {
      overlay.originalValue = scene.content;
    }
  }
}

/** AI Studio provider, feedback, translation, and tone routes. */
export function registerAiRoutes(app: Hono, deps: AiRouteDeps): void {
  const { baseDir, loadSession, isSameOriginSettingsRequest } = deps;

  const getAiProvidersResponse = async (signal?: AbortSignal) => {
    const providers = await getAiRuntime().listProviders({ signal });
    const defaultSelection = await resolveDefaultAiSelection(providers);
    const defaultProvider = defaultSelection
      ? providers.find((provider) => provider.id === defaultSelection.providerId) || null
      : null;
    return {
      available: providers.some((provider) => provider.configured),
      providers,
      defaultProvider: defaultProvider
        ? {
            id: defaultProvider.id,
            name: defaultProvider.name,
            ...(defaultSelection?.modelId ? { modelId: defaultSelection.modelId } : {}),
          }
        : null,
    };
  };

  app.get("/api/ai/providers", async (c) => {
    try {
      return c.json(await getAiProvidersResponse(c.req.raw.signal));
    } catch (err) {
      return c.json(
        { available: false, providers: [], error: await getAiRuntime().getSafeErrorMessage(err) },
        500,
      );
    }
  });

  // Keep the old endpoint name as a compatibility alias for existing viewers.
  app.get("/api/feedback/detect", async (c) => {
    try {
      const response = await getAiProvidersResponse(c.req.raw.signal);
      const defaultProvider = response.defaultProvider;
      return c.json({
        ...response,
        tool: defaultProvider ? { name: defaultProvider.id } : undefined,
        tools: response.providers.map((provider) => ({
          name: provider.id,
          label: provider.name,
        })),
        defaultTool: defaultProvider ? { name: defaultProvider.id } : undefined,
      });
    } catch (err) {
      return c.json(
        { available: false, providers: [], error: await getAiRuntime().getSafeErrorMessage(err) },
        500,
      );
    }
  });

  app.post("/api/ai/custom", async (c) => {
    if (!isSameOriginSettingsRequest(c)) {
      return c.json({ error: "AI provider requests must be same-origin" }, 403);
    }

    const body = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }
    const value = body as {
      name?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
    };
    if (typeof value.baseUrl !== "string" || !value.baseUrl.trim()) {
      return c.json({ error: "baseUrl is required" }, 400);
    }
    if (value.name !== undefined && typeof value.name !== "string") {
      return c.json({ error: "name must be a string" }, 400);
    }
    if (value.apiKey !== undefined && typeof value.apiKey !== "string") {
      return c.json({ error: "apiKey must be a string" }, 400);
    }

    try {
      const runtime = getAiRuntime();
      await runtime.configureCustomProvider(
        {
          baseUrl: value.baseUrl,
          ...(typeof value.name === "string" ? { name: value.name } : {}),
        },
        typeof value.apiKey === "string" ? value.apiKey : undefined,
        c.req.raw.signal,
      );
      return c.json({ ok: true, ...(await getAiProvidersResponse(c.req.raw.signal)) });
    } catch (err) {
      return c.json({ error: await getAiRuntime().getSafeErrorMessage(err) }, 400);
    }
  });

  app.delete("/api/ai/custom", async (c) => {
    if (!isSameOriginSettingsRequest(c)) {
      return c.json({ error: "AI provider requests must be same-origin" }, 403);
    }
    try {
      const runtime = getAiRuntime();
      await runtime.removeCustomProvider(c.req.raw.signal);
      return c.json({ ok: true, ...(await getAiProvidersResponse(c.req.raw.signal)) });
    } catch (err) {
      return c.json({ error: await getAiRuntime().getSafeErrorMessage(err) }, 400);
    }
  });

  app.post("/api/ai/auth", async (c) => {
    if (!isSameOriginSettingsRequest(c)) {
      return c.json({ error: "AI authentication requests must be same-origin" }, 403);
    }

    const body = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }

    const value = body as {
      providerId?: unknown;
      method?: unknown;
      apiKey?: unknown;
    };
    if (typeof value.providerId !== "string" || !value.providerId.trim()) {
      return c.json({ error: "providerId is required" }, 400);
    }
    if (value.method !== "api_key" && value.method !== "oauth") {
      return c.json({ error: "method must be api_key or oauth" }, 400);
    }

    try {
      const runtime = getAiRuntime();
      const providerId = value.providerId.trim();
      if (value.method === "api_key") {
        if (typeof value.apiKey !== "string") {
          return c.json({ error: "apiKey is required for API-key authentication" }, 400);
        }
        await runtime.saveApiKey(providerId, value.apiKey, c.req.raw.signal);
      } else {
        await runtime.login(providerId, "oauth", createBrowserAuthInteraction(c.req.raw.signal));
      }
      return c.json({ ok: true, ...(await getAiProvidersResponse(c.req.raw.signal)) });
    } catch (err) {
      return c.json({ error: await getAiRuntime().getSafeErrorMessage(err) }, 400);
    }
  });

  app.delete("/api/ai/auth", async (c) => {
    if (!isSameOriginSettingsRequest(c)) {
      return c.json({ error: "AI authentication requests must be same-origin" }, 403);
    }
    const providerId = c.req.query("providerId")?.trim();
    if (!providerId) return c.json({ error: "providerId is required" }, 400);
    try {
      const runtime = getAiRuntime();
      await runtime.logout(providerId, c.req.raw.signal);
      return c.json({ ok: true, ...(await getAiProvidersResponse(c.req.raw.signal)) });
    } catch (err) {
      return c.json({ error: await getAiRuntime().getSafeErrorMessage(err) }, 400);
    }
  });

  // AI Feedback — generate feedback annotations (requires slug)
  app.post("/api/feedback/generate", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);

    try {
      const body = await c.req.json().catch(() => ({}));
      const ai = await resolveAiSelection(body, c.req.raw.signal);

      const targetSession = await loadSession(result.slug, targetId);

      const fb = await generateFeedback(targetSession, ai.selection, {
        signal: c.req.raw.signal,
      });
      if (!fb) return c.json({ error: "AI Coach returned no feedback" }, 422);

      const existingAnns = targetSession.annotations ?? [];
      const newAnnotations = [
        ...existingAnns.filter((a) => a.author !== "vibe-feedback"),
        ...fb.annotations,
      ];

      // Persist
      try {
        await saveAnnotations(baseDir, result.slug, newAnnotations, targetId);
      } catch {
        /* ignore */
      }

      return c.json({
        annotations: newAnnotations,
        score: fb.result.score,
        itemCount: fb.result.feedbackItems.length,
        outcome: fb.result.outcome,
        sessionGoal: fb.result.sessionGoal,
        providerId: ai.selection.providerId,
        providerName: ai.providerName,
        modelId: ai.modelId,
        authType: ai.authType,
        authSubscription: ai.authSubscription,
        authSource: ai.authSource,
      });
    } catch (err) {
      return c.json({ error: await getAiRuntime().getSafeErrorMessage(err) }, 500);
    }
  });

  // --- AI Studio: Translate (requires slug) ---
  app.post("/api/studio/translate", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);

    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        providerId?: unknown;
        modelId?: unknown;
        toolName?: unknown;
        targetLang?: unknown;
        sourceLang?: unknown;
      };
      const ai = await resolveAiSelection(body, c.req.raw.signal);

      const targetSession = await loadSession(result.slug, targetId);
      const targetLang = typeof body.targetLang === "string" ? body.targetLang : "English";
      const sourceLang = typeof body.sourceLang === "string" ? body.sourceLang : undefined;

      // Load existing overlays BEFORE generation so we can chain operations
      const existing = await loadOverlays(baseDir, result.slug, targetId);
      // Remove translate overlays — we're replacing them. Keep others (tone etc.) for chaining.
      const nonTranslateOverlays = existing.overlays.filter((o) => o.source.type !== "translate");
      const chainBase: SessionOverlays = { version: 1, overlays: nonTranslateOverlays };
      const effectiveSession = sessionWithEffectiveContent(targetSession, chainBase);

      const translationResult = await generateTranslation(
        effectiveSession,
        ai.selection,
        { targetLang, sourceLang },
        { signal: c.req.raw.signal },
      );
      if (!translationResult) return c.json({ error: "Translation returned no result" }, 422);
      fixOriginalValues(translationResult.overlays, targetSession);
      const merged: SessionOverlays = {
        version: 1,
        overlays: [...nonTranslateOverlays, ...translationResult.overlays],
      };
      await saveOverlays(baseDir, result.slug, merged, targetId);

      return c.json({
        overlays: merged,
        stats: translationResult.stats,
        providerId: ai.selection.providerId,
        providerName: ai.providerName,
        modelId: ai.modelId,
        authType: ai.authType,
        authSubscription: ai.authSubscription,
        authSource: ai.authSource,
      });
    } catch (err) {
      return c.json({ error: await getAiRuntime().getSafeErrorMessage(err) }, 500);
    }
  });

  // --- AI Studio: Tone Adjustment (requires slug) ---
  app.post("/api/studio/tone", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);

    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        providerId?: unknown;
        modelId?: unknown;
        toolName?: unknown;
        style?: unknown;
      };
      const ai = await resolveAiSelection(body, c.req.raw.signal);

      const targetSession = await loadSession(result.slug, targetId);
      const style =
        typeof body.style === "string" &&
        ["professional", "neutral", "friendly"].includes(body.style)
          ? (body.style as "professional" | "neutral" | "friendly")
          : "professional";

      // Load existing overlays BEFORE generation so we can chain operations
      const existing = await loadOverlays(baseDir, result.slug, targetId);
      // Remove tone overlays — we're replacing them. Keep others (translate etc.) for chaining.
      const nonToneOverlays = existing.overlays.filter((o) => o.source.type !== "tone");
      const chainBase: SessionOverlays = { version: 1, overlays: nonToneOverlays };
      const effectiveSession = sessionWithEffectiveContent(targetSession, chainBase);

      const toneResult = await generateToneAdjustment(
        effectiveSession,
        ai.selection,
        { style },
        { signal: c.req.raw.signal },
      );
      if (!toneResult) return c.json({ error: "Tone adjustment returned no result" }, 422);
      fixOriginalValues(toneResult.overlays, targetSession);
      const merged: SessionOverlays = {
        version: 1,
        overlays: [...nonToneOverlays, ...toneResult.overlays],
      };
      await saveOverlays(baseDir, result.slug, merged, targetId);

      return c.json({
        overlays: merged,
        stats: toneResult.stats,
        providerId: ai.selection.providerId,
        providerName: ai.providerName,
        modelId: ai.modelId,
        authType: ai.authType,
        authSubscription: ai.authSubscription,
        authSource: ai.authSource,
      });
    } catch (err) {
      return c.json({ error: await getAiRuntime().getSafeErrorMessage(err) }, 500);
    }
  });
}
