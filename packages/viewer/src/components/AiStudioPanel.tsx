import { useCallback, useState } from "react";
import type { AnnotationActions } from "../hooks/useAnnotations";
import type { OverlayActions } from "../hooks/useOverlays";

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
    studioTools,
    studioToolName,
    setStudioToolName,
    studioToolsAvailable,
    translating,
    toningDown,
    cancelStudio,
    runTranslate,
    runTone,
    overlays,
    overlayCount,
    revertOverlay,
    revertAll,
  } = overlayActions;

  const {
    runAiCoach,
    aiCoachRunning,
    cancelAiCoach,
    aiCoachTools,
    aiCoachToolName,
    setAiCoachToolName,
  } = annotationActions;

  const hasAiCoach = !!runAiCoach;
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

  const isAnyRunning = aiCoachRunning || translating || toningDown;

  // All tools from both sources (they share the same detection)
  const tools = studioTools.length > 0 ? studioTools : aiCoachTools;
  const toolName = studioToolName || aiCoachToolName;

  const handleRunCoach = useCallback(async () => {
    if (!runAiCoach) return;
    setCoachStatus(null);
    setShowRerunConfirm(null);
    try {
      const result = await runAiCoach();
      setCoachStatus({
        type: "success",
        text: `Score ${result.score}/10 \u2014 ${result.itemCount} comment(s)`,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setCoachStatus({ type: "error", text: e?.message || "AI Coach failed" });
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
        text: `${result.translated} prompt(s) translated, ${result.skipped} unchanged`,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setTranslateStatus({ type: "error", text: e?.message || "Translation failed" });
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
        text: `${result.adjusted} prompt(s) adjusted, ${result.skipped} unchanged`,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setToneStatus({ type: "error", text: e?.message || "Tone adjustment failed" });
    }
  }, [runTone, toneStyle]);

  const hasExistingOverlays = (type: string) =>
    overlays.overlays.some((o) => o.source.type === type);

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

  // Null state: no tools available
  if (!studioToolsAvailable && aiCoachTools.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-terminal-border-subtle flex items-center gap-2">
          <SparkleIcon size={12} />
          <span className="text-[10px] font-sans font-semibold text-terminal-text uppercase tracking-widest">
            AI Studio
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center px-5 py-8 text-center">
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
          <div className="text-xs font-sans font-semibold text-terminal-text mb-1">
            No AI tools detected
          </div>
          <p className="text-[11px] font-mono text-terminal-dim mb-4 leading-relaxed">
            AI Studio requires a local CLI tool to run. Install one of the following:
          </p>
          <div className="w-full space-y-2 text-left">
            {[
              { name: "Claude Code", cmd: "npm install -g @anthropic-ai/claude-code", rec: true },
              { name: "Cursor CLI", cmd: 'Bundled with Cursor IDE (run as "agent")' },
              { name: "OpenCode", cmd: "go install github.com/opencode-ai/opencode@latest" },
            ].map((t) => (
              <div
                key={t.name}
                className="px-3 py-2 rounded-lg bg-terminal-surface border border-terminal-border-subtle"
              >
                <div className="text-[11px] font-sans font-medium text-terminal-text flex items-center gap-1.5">
                  {t.name}
                  {t.rec && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-terminal-green-subtle text-terminal-green">
                      recommended
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-mono text-terminal-dim mt-0.5 break-all">
                  {t.cmd}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[10px] font-mono text-terminal-dimmer leading-relaxed">
            All tools run locally using your own API token. No session data is sent to vibe-replay
            servers.
          </p>
        </div>
      </div>
    );
  }

  const sourceLabel = (type: string) => {
    if (type === "translate") return "Translated";
    if (type === "tone") return "Softened";
    return "Modified";
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-terminal-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SparkleIcon size={12} />
          <span className="text-[10px] font-sans font-semibold text-terminal-text uppercase tracking-widest">
            AI Studio
          </span>
        </div>
        {overlayCount > 0 && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple tabular-nums">
            {overlayCount} modified
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Tool status */}
        <div className="px-3 py-2.5 border-b border-terminal-border-subtle bg-terminal-surface/30">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-terminal-dim">Tool</span>
            {tools.length > 1 && setStudioToolName ? (
              <select
                value={toolName || ""}
                onChange={(e) => {
                  setStudioToolName(e.target.value);
                  if (setAiCoachToolName) setAiCoachToolName(e.target.value);
                }}
                className="bg-terminal-surface border border-terminal-border rounded-lg px-2 py-0.5 text-[11px] font-mono text-terminal-text outline-none cursor-pointer hover:border-terminal-purple/30 transition-colors"
              >
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[11px] font-mono font-medium text-terminal-text px-2 py-0.5 rounded-lg bg-terminal-surface border border-terminal-border">
                {toolName}
              </span>
            )}
          </div>
          <p className="text-[10px] font-mono text-terminal-dimmer mt-1 leading-relaxed">
            Runs locally using your own API token. No data sent to vibe-replay servers.
          </p>
        </div>

        {/* Feature cards */}
        <div className="p-3 space-y-2.5">
          {/* AI Coach */}
          {hasAiCoach && (
            <FeatureCard
              title="AI Coach"
              description="Analyze your prompting technique and get actionable feedback as inline comments."
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
          {runTranslate && (
            <FeatureCard
              title="Translate"
              description="Translate user prompts for sharing with international colleagues."
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
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[10px] font-mono text-terminal-dim">Target</span>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    disabled={isAnyRunning}
                    className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-0.5 text-[11px] font-mono text-terminal-text outline-none disabled:opacity-50"
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
          {runTone && (
            <FeatureCard
              title="Soften Tone"
              description="Make prompts more professional and constructive for comfortable sharing."
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
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[10px] font-mono text-terminal-dim">Style</span>
                  <select
                    value={toneStyle}
                    onChange={(e) =>
                      setToneStyle(e.target.value as "professional" | "neutral" | "friendly")
                    }
                    disabled={isAnyRunning}
                    className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-0.5 text-[11px] font-mono text-terminal-text outline-none disabled:opacity-50"
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

        {/* Modifications list */}
        {overlayCount > 0 && (
          <div className="border-t border-terminal-border-subtle">
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest">
                Modifications
              </span>
              <button
                onClick={revertAll}
                className="text-[10px] font-mono text-terminal-dim hover:text-terminal-red transition-colors"
              >
                Revert All
              </button>
            </div>
            <div className="px-3 pb-3 space-y-1.5">
              {overlays.overlays.map((overlay) => (
                <div
                  key={overlay.id}
                  className="px-2.5 py-2 rounded-lg bg-terminal-surface/50 border border-terminal-border-subtle"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-mono text-terminal-dim">
                      Scene {overlay.sceneIndex}
                      <span className="mx-1 text-terminal-border">&middot;</span>
                      <span className="text-terminal-purple">
                        {sourceLabel(overlay.source.type)}
                      </span>
                    </span>
                    <button
                      onClick={() => revertOverlay(overlay.id)}
                      className="text-[10px] font-mono text-terminal-dim hover:text-terminal-red transition-colors"
                    >
                      Revert
                    </button>
                  </div>
                  <div className="text-[10px] font-mono text-terminal-dimmer line-clamp-1">
                    {overlay.originalValue.slice(0, 60)}
                    {overlay.originalValue.length > 60 ? "..." : ""}
                  </div>
                  <div className="text-[10px] font-mono text-terminal-text line-clamp-1 mt-0.5">
                    &rarr; {overlay.modifiedValue.slice(0, 60)}
                    {overlay.modifiedValue.length > 60 ? "..." : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FeatureCard sub-component
// ---------------------------------------------------------------------------

interface FeatureCardProps {
  title: string;
  description: string;
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
      <div className="px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-sans font-semibold text-terminal-text">{title}</div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5 leading-relaxed">
              {description}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            {running && onCancel && (
              <button
                onClick={onCancel}
                className="text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={onRun}
              disabled={disabled}
              className="px-2.5 py-1 text-[10px] font-mono rounded-lg bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis transition-colors disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
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
          </div>
        </div>
        {config}
      </div>
      {showRerunConfirm && !running && (
        <div className="px-3 pb-2.5">
          <div className="flex items-center gap-2 text-[10px] font-mono">
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
          className={`px-3 pb-2.5 text-[10px] font-mono ${
            status.type === "success" ? "text-terminal-green" : "text-terminal-red"
          }`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
