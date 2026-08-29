import { useCallback, useEffect, useState } from "react";
import type { AnnotationActions } from "../hooks/useAnnotations";
import type { OverlayActions } from "../hooks/useOverlays";
import { navigateTo } from "./dashboard-utils";
import { AiProviderSettingsModal } from "./AiProviderSettings";

interface Props {
  annotationActions: AnnotationActions;
  overlayActions: OverlayActions;
}

// Sparkle icon (AI Studio logo)
function SparkleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin h-3.5 w-3.5 ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function providerRunSuffix(result: {
  providerId: string;
  providerName: string;
  modelId: string;
  authType: string;
  authSubscription: boolean;
}): string {
  const billing = result.authSubscription
    ? "subscription"
    : result.authType === "oauth"
      ? "OAuth"
      : "API key";
  return ` via ${result.providerName || result.providerId} · ${result.modelId} · ${billing}`;
}

const TARGET_LANGUAGES = [
  "English",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Japanese",
  "Korean",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Russian",
];

const TONE_STYLES = [
  { value: "professional" as const, label: "Professional" },
  { value: "neutral" as const, label: "Neutral" },
  { value: "friendly" as const, label: "Friendly" },
];

export default function AiStudioPanel({ annotationActions, overlayActions }: Props) {
  const {
    studioProviders,
    studioProviderId,
    studioModelId,
    setStudioProviderId,
    setStudioModelId,
    translating,
    toningDown,
    cancelStudio,
    runTranslate,
    runTone,
    overlayCount,
    revertAll,
  } = overlayActions;

  const {
    runAiCoach,
    aiCoachRunning,
    cancelAiCoach,
    aiProviders,
    aiProviderId,
    aiModelId,
    aiProvidersLoading,
    setAiProviderId,
    setAiModelId,
  } = annotationActions;

  const hasAiFeedback = annotationActions.annotations.some((a) => a.author === "vibe-feedback");

  // Feature states
  const [targetLang, setTargetLang] = useState("English");
  const [toneStyle, setToneStyle] = useState<"professional" | "neutral" | "friendly">(
    "professional",
  );
  const [coachStatus, setCoachStatus] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [translateStatus, setTranslateStatus] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [toneStatus, setToneStatus] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );
  const [showRerunConfirm, setShowRerunConfirm] = useState<"coach" | "translate" | "tone" | null>(
    null,
  );
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);

  const isAnyRunning = aiCoachRunning || translating || toningDown;

  // Both hooks discover the same provider registry. Keep the annotation hook as
  // the source for setup/status and synchronize the selection into overlays.
  const providers = aiProviders.length > 0 ? aiProviders : studioProviders;
  const providerId = aiProviderId || studioProviderId;
  const modelId = aiModelId || studioModelId;
  const selectedProvider = providers.find((provider) => provider.id === providerId) || null;
  const providerConfigured = selectedProvider?.configured === true;
  const providerReady = providerConfigured && (selectedProvider?.models.length || 0) > 0;
  const hasAiCoach = providerReady && !!runAiCoach;

  useEffect(() => {
    if (aiProviderId && aiProviderId !== studioProviderId) {
      setStudioProviderId?.(aiProviderId);
    }
    if (aiModelId && aiModelId !== studioModelId) {
      setStudioModelId?.(aiModelId);
    }
  }, [
    aiModelId,
    aiProviderId,
    setStudioModelId,
    setStudioProviderId,
    studioModelId,
    studioProviderId,
  ]);

  const handleProviderChange = (nextProviderId: string) => {
    setAiProviderId?.(nextProviderId);
    setStudioProviderId?.(nextProviderId);
  };

  const handleModelChange = (nextModelId: string) => {
    setAiModelId?.(nextModelId);
    setStudioModelId?.(nextModelId);
  };

  const openFullSettings = useCallback(() => {
    setProviderSettingsOpen(false);
    navigateTo({ view: "dashboard", session: null, tab: "settings" });
  }, []);

  const handleRunCoach = useCallback(async () => {
    if (!runAiCoach) return;
    setCoachStatus(null);
    setShowRerunConfirm(null);
    try {
      const result = await runAiCoach();
      setCoachStatus({
        type: "success",
        text: `Score ${result.score}/10 \u2014 ${result.itemCount} comment(s)${providerRunSuffix(result)}`,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setCoachStatus({ type: "error", text: e instanceof Error ? e.message : "AI Coach failed" });
    }
  }, [runAiCoach]);

  const handleRunTranslate = useCallback(async () => {
    if (!runTranslate) return;
    setTranslateStatus(null);
    setShowRerunConfirm(null);
    try {
      const result = await runTranslate({ targetLang });
      setTranslateStatus({
        type: "success",
        text: `${result.translated} message(s) translated, ${result.skipped} unchanged${providerRunSuffix(result)}`,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setTranslateStatus({
        type: "error",
        text: e instanceof Error ? e.message : "Translation failed",
      });
    }
  }, [runTranslate, targetLang]);

  const handleRunTone = useCallback(async () => {
    if (!runTone) return;
    setToneStatus(null);
    setShowRerunConfirm(null);
    try {
      const result = await runTone({ style: toneStyle });
      setToneStatus({
        type: "success",
        text: `${result.adjusted} prompt(s) adjusted, ${result.skipped} unchanged${providerRunSuffix(result)}`,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setToneStatus({
        type: "error",
        text: e instanceof Error ? e.message : "Tone adjustment failed",
      });
    }
  }, [runTone, toneStyle]);

  const hasExistingOverlays = (type: string) =>
    overlayActions.overlays.overlays.some((o) => o.source.type === type);

  const handleFeatureRun = (feature: "coach" | "translate" | "tone") => {
    if (feature === "coach" && hasAiFeedback) {
      setShowRerunConfirm("coach");
      return;
    }
    if (feature === "translate" && hasExistingOverlays("translate")) {
      setShowRerunConfirm("translate");
      return;
    }
    if (feature === "tone" && hasExistingOverlays("tone")) {
      setShowRerunConfirm("tone");
      return;
    }
    if (feature === "coach") void handleRunCoach();
    else if (feature === "translate") void handleRunTranslate();
    else void handleRunTone();
  };

  // This should only happen if the embedded Pi runtime could not initialize.
  if (providers.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2.5 border-b border-terminal-border-subtle flex items-center gap-2">
          <SparkleIcon size={12} />
          <span className="text-[10px] font-sans font-semibold text-terminal-text uppercase tracking-widest">
            AI Studio
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 text-center">
          <div className="w-10 h-10 rounded-xl bg-terminal-surface flex items-center justify-center mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-terminal-dim"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="text-sm font-sans font-semibold text-terminal-text mb-1">
            {aiProvidersLoading ? "Loading AI providers…" : "Pi AI runtime unavailable"}
          </div>
          <p className="text-xs font-mono text-terminal-dim leading-relaxed">
            {aiProvidersLoading
              ? "Fetching the local provider catalog."
              : "Restart vibe-replay and check the local AI runtime diagnostics."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-terminal-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SparkleIcon size={12} />
          <span className="text-[10px] font-sans font-semibold text-terminal-text uppercase tracking-widest">
            AI Studio
          </span>
        </div>
        {overlayCount > 0 && (
          <button
            onClick={revertAll}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-red-subtle hover:text-terminal-red transition-colors"
          >
            Revert All ({overlayCount})
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-terminal-border-subtle bg-terminal-surface/30 px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-mono text-terminal-dim">Provider</div>
              <div className="mt-1 truncate text-xs font-mono font-semibold text-terminal-text">
                {selectedProvider?.name || "Select a provider"}
                {selectedProvider?.models.length
                  ? ` · ${modelId || selectedProvider.models[0].id}`
                  : ""}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setProviderSettingsOpen(true)}
                disabled={isAnyRunning}
                className="rounded-lg bg-terminal-purple-subtle px-2.5 py-1.5 text-[10px] font-mono font-semibold text-terminal-purple transition-colors hover:bg-terminal-purple/20 disabled:opacity-40"
              >
                Manage
              </button>
              <button
                type="button"
                onClick={openFullSettings}
                disabled={isAnyRunning}
                className="rounded-lg bg-terminal-surface-2 px-2.5 py-1.5 text-[10px] font-mono text-terminal-dim transition-colors hover:text-terminal-text disabled:opacity-40"
              >
                Settings
              </button>
            </div>
          </div>
          <p className="text-[10px] font-mono leading-relaxed text-terminal-dimmer">
            Choose a provider and model, or open Manage to connect a key, OAuth account, or local
            OpenAI-compatible gateway.
          </p>
          {annotationActions.aiProvidersError && (
            <div role="alert" className="text-[10px] font-mono leading-relaxed text-terminal-red">
              {annotationActions.aiProvidersError}
            </div>
          )}
        </div>

        <AiProviderSettingsModal
          open={providerSettingsOpen}
          onClose={() => setProviderSettingsOpen(false)}
          actions={annotationActions}
          busy={isAnyRunning}
          onProviderChange={handleProviderChange}
          onModelChange={handleModelChange}
          onOpenSettings={openFullSettings}
        />

        {/* Feature cards */}
        <div className="p-4 space-y-3">
          {!providerConfigured && (
            <div className="rounded-xl border border-terminal-orange/30 bg-terminal-orange-subtle px-4 py-3 text-xs font-mono leading-relaxed text-terminal-orange">
              Connect the selected provider above to enable AI Coach, Translate, and Soften Tone.
            </div>
          )}
          {providerConfigured && !providerReady && (
            <div className="rounded-xl border border-terminal-orange/30 bg-terminal-orange-subtle px-4 py-3 text-xs font-mono leading-relaxed text-terminal-orange">
              No usable models were discovered for this endpoint. Check its <code>/models</code>{" "}
              response and try Discover again.
            </div>
          )}

          {/* AI Coach */}
          {hasAiCoach && (
            <FeatureCard
              title="AI Coach"
              preview={
                <div className="mt-2.5 rounded-lg bg-terminal-surface-inset border border-terminal-border overflow-hidden">
                  <div className="px-3 py-2.5 border-b border-terminal-border-subtle">
                    <div className="text-xs font-mono text-terminal-green leading-relaxed">
                      Fix the login bug users reported
                    </div>
                  </div>
                  <div className="px-3 py-2 flex items-start gap-2">
                    <span className="text-xs shrink-0">{"\uD83D\uDCAC"}</span>
                    <span className="text-xs font-mono text-terminal-blue leading-relaxed">
                      Be specific — which file? what error?
                    </span>
                  </div>
                  <div className="px-3 py-2 border-t border-terminal-border-subtle flex items-center gap-2">
                    <span className="text-xs font-mono font-semibold text-terminal-orange">
                      6/10
                    </span>
                    <span className="text-xs font-mono text-terminal-dimmer">
                      {"·"} 4 comments added inline
                    </span>
                  </div>
                </div>
              }
              description="Score your prompting technique and get inline coaching comments."
              running={aiCoachRunning}
              disabled={isAnyRunning}
              status={coachStatus}
              buttonLabel={hasAiFeedback ? "Re-run Coach" : "Run Coach"}
              runningLabel="Analyzing..."
              onRun={() => handleFeatureRun("coach")}
              onCancel={cancelAiCoach || undefined}
              showRerunConfirm={showRerunConfirm === "coach"}
              rerunWarning="Existing AI feedback will be replaced."
              onConfirmRerun={() => void handleRunCoach()}
              onCancelRerun={() => setShowRerunConfirm(null)}
            />
          )}

          {/* Translate */}
          {providerReady && runTranslate && (
            <FeatureCard
              title="Translate"
              preview={
                <div className="mt-2.5 rounded-lg bg-terminal-surface-inset border border-terminal-border overflow-hidden">
                  <div className="px-3 py-2.5 space-y-1">
                    <div className="text-xs font-mono text-terminal-dim line-through opacity-60">
                      {"\u8FD9\u4E2Abug\u600E\u4E48\u4FEE\uFF1F"}
                    </div>
                    <div className="text-xs font-mono text-terminal-green">
                      How to fix this bug?
                    </div>
                  </div>
                  <div className="px-3 py-2.5 border-t border-terminal-border-subtle space-y-1">
                    <div className="text-xs font-mono text-terminal-dim line-through opacity-60">
                      {"\u5DF2\u5199\u5165\u3002\u4EE5\u540E\u7528\u4E2D\u6587\u95EE\u6211..."}
                    </div>
                    <div className="text-xs font-mono text-terminal-blue">
                      Done. Ask me in Chinese...
                    </div>
                  </div>
                </div>
              }
              description="Translate all prompts and responses for sharing with international teams."
              running={translating}
              disabled={isAnyRunning}
              status={translateStatus}
              buttonLabel={hasExistingOverlays("translate") ? "Re-translate" : "Translate All"}
              runningLabel="Translating..."
              onRun={() => handleFeatureRun("translate")}
              onCancel={cancelStudio || undefined}
              showRerunConfirm={showRerunConfirm === "translate"}
              rerunWarning="Existing translations will be replaced."
              onConfirmRerun={() => void handleRunTranslate()}
              onCancelRerun={() => setShowRerunConfirm(null)}
              config={
                <div className="flex items-center gap-2 mt-2.5">
                  <span className="text-xs font-mono text-terminal-dim shrink-0">Target</span>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    disabled={isAnyRunning}
                    className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text outline-none disabled:opacity-50"
                  >
                    {TARGET_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </select>
                </div>
              }
            />
          )}

          {/* Soften Tone */}
          {providerReady && runTone && (
            <FeatureCard
              title="Soften Tone"
              preview={
                <div className="mt-2.5 rounded-lg bg-terminal-surface-inset border border-terminal-border overflow-hidden">
                  <div className="px-3 py-2.5 space-y-1">
                    <div className="text-xs font-mono text-terminal-red line-through opacity-60">
                      this code is mass garbage, mass delete it
                    </div>
                    <div className="text-xs font-mono text-terminal-green">
                      Let's refactor this module for clarity
                    </div>
                  </div>
                  <div className="px-3 py-2.5 border-t border-terminal-border-subtle space-y-1">
                    <div className="text-xs font-mono text-terminal-red line-through opacity-60">
                      are you stupid? I said fix the auth
                    </div>
                    <div className="text-xs font-mono text-terminal-green">
                      The auth issue is still present, could you revisit?
                    </div>
                  </div>
                </div>
              }
              description="Rewrite harsh or blunt prompts into professional, constructive language."
              running={toningDown}
              disabled={isAnyRunning}
              status={toneStatus}
              buttonLabel={hasExistingOverlays("tone") ? "Re-adjust" : "Soften All"}
              runningLabel="Adjusting..."
              onRun={() => handleFeatureRun("tone")}
              onCancel={cancelStudio || undefined}
              showRerunConfirm={showRerunConfirm === "tone"}
              rerunWarning="Existing tone adjustments will be replaced."
              onConfirmRerun={() => void handleRunTone()}
              onCancelRerun={() => setShowRerunConfirm(null)}
              config={
                <div className="flex items-center gap-2 mt-2.5">
                  <span className="text-xs font-mono text-terminal-dim shrink-0">Style</span>
                  <select
                    value={toneStyle}
                    onChange={(e) =>
                      setToneStyle(e.target.value as "professional" | "neutral" | "friendly")
                    }
                    disabled={isAnyRunning}
                    className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text outline-none disabled:opacity-50"
                  >
                    {TONE_STYLES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FeatureCard sub-component — vertical stacking layout
// ---------------------------------------------------------------------------

interface FeatureCardProps {
  title: string;
  preview?: React.ReactNode;
  description?: string;
  running: boolean;
  disabled: boolean;
  status: { type: "success" | "error"; text: string } | null;
  buttonLabel: string;
  runningLabel: string;
  onRun: () => void;
  onCancel?: () => void;
  showRerunConfirm: boolean;
  rerunWarning: string;
  onConfirmRerun: () => void;
  onCancelRerun: () => void;
  config?: React.ReactNode;
}

function FeatureCard({
  title,
  preview,
  description,
  running,
  disabled,
  status,
  buttonLabel,
  runningLabel,
  onRun,
  onCancel,
  showRerunConfirm,
  rerunWarning,
  onConfirmRerun,
  onCancelRerun,
  config,
}: FeatureCardProps) {
  return (
    <div className="rounded-xl border border-terminal-border-subtle bg-terminal-surface/30 overflow-hidden">
      <div className="px-4 py-3">
        <div className="text-sm font-sans font-semibold text-terminal-text">{title}</div>
        {preview}
        {description && (
          <div className="text-xs font-mono text-terminal-dim mt-2 leading-relaxed">
            {description}
          </div>
        )}
        {config}
        {/* Action row */}
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={onRun}
            disabled={disabled}
            className="px-3.5 py-1.5 text-xs font-mono rounded-lg bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis transition-colors disabled:opacity-40 flex items-center gap-1.5"
          >
            {running ? (
              <>
                <Spinner className="text-terminal-purple" />
                {runningLabel}
              </>
            ) : (
              buttonLabel
            )}
          </button>
          {running && onCancel && (
            <button
              onClick={onCancel}
              className="text-xs font-mono text-terminal-dim hover:text-terminal-text transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {showRerunConfirm && !running && (
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="text-terminal-orange flex-1">{rerunWarning}</span>
            <button
              onClick={onCancelRerun}
              className="text-terminal-dim hover:text-terminal-text transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirmRerun}
              className="text-terminal-purple hover:text-terminal-text transition-colors font-medium"
            >
              Continue
            </button>
          </div>
        </div>
      )}
      {status && (
        <div
          className={`px-4 pb-3 text-xs font-mono ${
            status.type === "success" ? "text-terminal-green" : "text-terminal-red"
          }`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
