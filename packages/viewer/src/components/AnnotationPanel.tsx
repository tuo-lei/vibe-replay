import { marked } from "marked";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, Scene } from "../types";

// Configure marked for short-form annotation text
marked.setOptions({ breaks: true, gfm: true });

import type { AnnotationActions } from "../hooks/useAnnotations";

interface Props {
  actions: AnnotationActions;
  scenes: Scene[];
  currentIndex: number;
  totalScenes: number;
  onSeek: (index: number) => void;
  addingForScene: number | null;
  onClearAddingTarget: () => void;
  readOnly?: boolean;
}

/** Get a short preview of what a scene contains */
function scenePreview(scene: Scene): { label: string; text: string } {
  switch (scene.type) {
    case "user-prompt": {
      const first = scene.content.split("\n").find((l) => l.trim()) || "";
      return { label: "You", text: first.slice(0, 100) };
    }
    case "compaction-summary":
      return { label: "Compaction", text: scene.content.slice(0, 80) };
    case "thinking":
      return { label: "Thinking", text: scene.content.slice(0, 80) };
    case "text-response": {
      const first = scene.content.split("\n").find((l) => l.trim()) || "";
      return { label: "Response", text: first.slice(0, 100) };
    }
    case "tool-call":
      return {
        label: scene.toolName,
        text:
          scene.diff?.filePath ||
          scene.bashOutput?.command ||
          Object.values(scene.input)
            .filter((v) => typeof v === "string")
            .join(", ")
            .slice(0, 80) ||
          "",
      };
  }
}

function sceneLabelColor(scene: Scene): string {
  switch (scene.type) {
    case "user-prompt":
      return "text-terminal-green";
    case "compaction-summary":
      return "text-terminal-dim";
    case "thinking":
      return "text-terminal-purple";
    case "text-response":
      return "text-terminal-blue";
    case "tool-call":
      return "text-terminal-orange";
  }
}

export default function AnnotationPanel({
  actions,
  scenes,
  currentIndex,
  totalScenes: _totalScenes,
  onSeek,
  addingForScene,
  onClearAddingTarget,
  readOnly = false,
}: Props) {
  const {
    annotations,
    add,
    update,
    remove,
    hasUnsaved,
    canSaveHtml,
    downloadHtml,
    downloadJson,
    publishGist,
    exportHtml,
    gistPublishing,
    htmlExporting,
    aiCoachTool,
    aiCoachTools,
    aiCoachToolName,
    setAiCoachToolName,
    runAiCoach,
    cancelAiCoach,
    aiCoachRunning,
  } = actions;
  const [internalAdding, setInternalAdding] = useState<number | null>(null);
  const [newBody, setNewBody] = useState("");
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  const [showAiCoachConfirm, setShowAiCoachConfirm] = useState(false);

  // Check gh status in editor mode
  useEffect(() => {
    if (!publishGist) return;
    fetch("/api/gh-status")
      .then((r) => r.json())
      .then((data) => setGhAvailable(data.available ?? false))
      .catch(() => setGhAvailable(false));
  }, [publishGist]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const addFormRef = useRef<HTMLDivElement>(null);

  // External target from clicking a card's comment icon
  const activeAdding = addingForScene ?? internalAdding;

  // When an external target arrives, scroll the form into view
  useEffect(() => {
    if (addingForScene !== null) {
      setNewBody("");
      setInternalAdding(null);
      // Scroll to the add form after it renders
      setTimeout(() => {
        addFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        textareaRef.current?.focus();
      }, 50);
    }
  }, [addingForScene]);

  // Focus textarea when adding
  useEffect(() => {
    if (activeAdding !== null && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [activeAdding]);

  // Focus textarea when editing
  useEffect(() => {
    if (editingId && editTextareaRef.current) {
      editTextareaRef.current.focus();
    }
  }, [editingId]);

  // Sort annotations by sceneIndex
  const sorted = useMemo(
    () => [...annotations].sort((a, b) => a.sceneIndex - b.sceneIndex),
    [annotations],
  );

  // Auto-scroll to annotations near currentIndex
  useEffect(() => {
    if (!panelRef.current || activeAdding !== null) return;
    const cards = panelRef.current.querySelectorAll("[data-annotation-scene]");
    let closest: Element | null = null;
    let closestDist = Infinity;
    cards.forEach((card) => {
      const idx = Number(card.getAttribute("data-annotation-scene"));
      const dist = Math.abs(idx - currentIndex);
      if (dist < closestDist) {
        closestDist = dist;
        closest = card;
      }
    });
    if (closest && closestDist <= 3) {
      (closest as HTMLElement).scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [currentIndex, activeAdding]);

  const cancelAdding = useCallback(() => {
    setInternalAdding(null);
    setNewBody("");
    onClearAddingTarget();
  }, [onClearAddingTarget]);

  const handleAdd = useCallback(() => {
    if (!newBody.trim() || activeAdding === null) return;
    add(activeAdding, newBody.trim());
    setNewBody("");
    setInternalAdding(null);
    onClearAddingTarget();
  }, [add, activeAdding, newBody, onClearAddingTarget]);

  const handleUpdate = useCallback(() => {
    if (!editingId || !editBody.trim()) return;
    update(editingId, editBody.trim());
    setEditingId(null);
    setEditBody("");
  }, [editingId, editBody, update]);

  // Preview for the scene being commented on
  const addingPreview =
    activeAdding !== null && scenes[activeAdding] ? scenePreview(scenes[activeAdding]) : null;
  const addingLabelColor =
    activeAdding !== null && scenes[activeAdding] ? sceneLabelColor(scenes[activeAdding]) : "";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border/50">
        <span className="text-xs font-mono font-semibold text-terminal-text uppercase tracking-wider">
          Comments
        </span>
        <div className="flex items-center gap-2">
          {readOnly && (
            <span className="text-[9px] font-mono text-terminal-dim/60 uppercase px-1.5 py-0.5 rounded border border-terminal-border/40">
              Read-only
            </span>
          )}
          <span className="text-[10px] font-mono text-terminal-dim">{annotations.length}</span>
        </div>
      </div>

      {/* Annotation list */}
      <div ref={panelRef} className="flex-1 overflow-y-auto">
        {sorted.length === 0 && activeAdding === null && (
          <div className="px-3 py-8 text-center">
            <div className="text-terminal-dim text-xs font-mono mb-2">No comments yet</div>
            {!readOnly && (
              <div className="text-terminal-dim/60 text-[10px] font-mono">
                Hover over any message and click the comment icon to add one
              </div>
            )}
          </div>
        )}

        {sorted.map((annotation) => (
          <AnnotationCard
            key={annotation.id}
            annotation={annotation}
            scene={scenes[annotation.sceneIndex]}
            isCurrent={annotation.sceneIndex === currentIndex}
            isEditing={!readOnly && editingId === annotation.id}
            editBody={editingId === annotation.id ? editBody : ""}
            editTextareaRef={editingId === annotation.id ? editTextareaRef : undefined}
            onSeek={() => onSeek(annotation.sceneIndex)}
            onStartEdit={() => {
              setEditingId(annotation.id);
              setEditBody(annotation.body);
            }}
            onCancelEdit={() => {
              setEditingId(null);
              setEditBody("");
            }}
            onSaveEdit={handleUpdate}
            onEditBodyChange={setEditBody}
            onDelete={() => remove(annotation.id)}
            readOnly={readOnly}
          />
        ))}

        {/* New annotation form */}
        {!readOnly && activeAdding !== null && (
          <div
            ref={addFormRef}
            className="px-3 py-2.5 border-b border-terminal-border/30 bg-terminal-blue/[0.03]"
          >
            {/* Scene preview */}
            {addingPreview && (
              <div className="flex items-center gap-1.5 mb-2">
                <span
                  className={`text-[10px] font-mono font-semibold uppercase ${addingLabelColor}`}
                >
                  {addingPreview.label}
                </span>
                <span className="text-[10px] font-mono text-terminal-dim truncate">
                  {addingPreview.text}
                </span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleAdd();
                }
                if (e.key === "Escape") cancelAdding();
              }}
              placeholder="Add a comment... (Markdown supported)"
              className="w-full bg-terminal-surface border border-terminal-border/50 rounded px-2 py-1.5 text-xs font-mono text-terminal-text placeholder-terminal-dim/50 resize-none focus:outline-none focus:border-terminal-blue/50"
              rows={3}
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[9px] font-mono text-terminal-dim/50">
                {"\u2318"}+Enter to save
              </span>
              <div className="flex gap-1.5">
                <button
                  onClick={cancelAdding}
                  className="px-2 py-1 text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  disabled={!newBody.trim()}
                  className="px-2 py-1 text-[10px] font-mono bg-terminal-blue/15 text-terminal-blue rounded hover:bg-terminal-blue/25 transition-colors disabled:opacity-40"
                >
                  Comment
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer: Save/export/publish buttons + AI Coach */}
      {!readOnly && (annotations.length > 0 || runAiCoach) && (
        <div className="shrink-0 border-t border-terminal-border/50 px-3 py-2 space-y-1.5">
          {hasUnsaved && !publishGist && (
            <div className="text-[9px] font-mono text-terminal-orange text-center mb-1">
              Unsaved changes
            </div>
          )}
          {statusMsg && (
            <div
              className={`text-[9px] font-mono text-center mb-1 ${statusMsg.type === "success" ? "text-terminal-green" : "text-terminal-red"}`}
            >
              {statusMsg.type === "success" && statusMsg.text.startsWith("http") ? (
                <a
                  href={statusMsg.text}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-terminal-text transition-colors"
                >
                  {statusMsg.text}
                </a>
              ) : (
                statusMsg.text
              )}
            </div>
          )}

          {/* AI Coach (editor mode only) */}
          {runAiCoach &&
            !showAiCoachConfirm &&
            !aiCoachRunning &&
            (() => {
              const hasExisting = annotations.some((a) => a.author === "vibe-feedback");
              return (
                <button
                  onClick={() => setShowAiCoachConfirm(true)}
                  className="w-full px-2 py-1.5 text-[10px] font-mono bg-terminal-purple/15 text-terminal-purple rounded hover:bg-terminal-purple/25 transition-colors text-center border border-terminal-purple/30"
                >
                  {hasExisting ? "Re-run AI Coach (beta)" : "AI Coach (beta)"}
                </button>
              );
            })()}
          {showAiCoachConfirm &&
            !aiCoachRunning &&
            (() => {
              const hasExisting = annotations.some((a) => a.author === "vibe-feedback");
              return (
                <div className="space-y-1.5 p-2 rounded border border-terminal-purple/30 bg-terminal-purple/5">
                  <div className="text-[10px] font-mono text-terminal-purple font-semibold">
                    AI Coach (beta)
                  </div>
                  <div className="text-[9px] font-mono text-terminal-dim leading-relaxed">
                    Uses <span className="text-terminal-text">{aiCoachTool?.name}</span> CLI to
                    analyze your prompting technique. This will make API calls using your configured
                    credentials and may use tokens/cost money. Typically takes 1-3 minutes.
                    {hasExisting && (
                      <span className="block mt-1 text-terminal-orange">
                        This will replace existing AI Coach comments.
                      </span>
                    )}
                  </div>
                  {aiCoachTools.length > 1 && setAiCoachToolName && (
                    <label className="block text-[9px] font-mono text-terminal-dim">
                      Tool:
                      <select
                        value={aiCoachToolName || ""}
                        onChange={(e) => setAiCoachToolName(e.target.value)}
                        className="ml-1 bg-terminal-surface border border-terminal-border/50 rounded px-1.5 py-0.5 text-[9px] font-mono text-terminal-text"
                      >
                        {aiCoachTools.map((tool) => (
                          <option key={tool.name} value={tool.name}>
                            {tool.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="flex gap-1.5 justify-end">
                    <button
                      onClick={() => setShowAiCoachConfirm(false)}
                      className="px-2 py-1 text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={async () => {
                        setShowAiCoachConfirm(false);
                        try {
                          const result = await runAiCoach?.();
                          setStatusMsg({
                            type: "success",
                            text: `Score: ${result.score}/10 — ${result.itemCount} comment(s) added`,
                          });
                        } catch (e: any) {
                          if (e.name === "AbortError") return;
                          setStatusMsg({ type: "error", text: e.message });
                        }
                      }}
                      className="px-2 py-1 text-[10px] font-mono bg-terminal-purple/20 text-terminal-purple rounded hover:bg-terminal-purple/30 transition-colors"
                    >
                      Run
                    </button>
                  </div>
                </div>
              );
            })()}
          {aiCoachRunning && (
            <div className="flex items-center justify-center gap-2 py-2">
              <span className="text-[10px] font-mono text-terminal-purple animate-pulse">
                Analyzing your prompting patterns...
              </span>
              {cancelAiCoach && (
                <button
                  onClick={cancelAiCoach}
                  className="px-1.5 py-0.5 text-[9px] font-mono text-terminal-dim hover:text-terminal-red border border-terminal-border/40 rounded transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          )}

          {/* Editor mode: server-side actions */}
          {exportHtml && (
            <button
              onClick={async () => {
                setStatusMsg(null);
                try {
                  const path = await exportHtml();
                  setStatusMsg({ type: "success", text: `Saved: ${path}` });
                } catch (e: any) {
                  setStatusMsg({ type: "error", text: e.message });
                }
              }}
              disabled={htmlExporting}
              className="w-full px-2 py-1.5 text-[10px] font-mono bg-terminal-green/15 text-terminal-green rounded hover:bg-terminal-green/25 transition-colors text-center border border-terminal-green/30 disabled:opacity-50"
            >
              {htmlExporting ? "Exporting..." : "Export HTML"}
            </button>
          )}
          {publishGist && ghAvailable && (
            <button
              onClick={async () => {
                setStatusMsg(null);
                try {
                  const result = await publishGist();
                  setStatusMsg({ type: "success", text: result.viewerUrl });
                } catch (e: any) {
                  setStatusMsg({ type: "error", text: e.message });
                }
              }}
              disabled={gistPublishing}
              className="w-full px-2 py-1.5 text-[10px] font-mono bg-terminal-purple/15 text-terminal-purple rounded hover:bg-terminal-purple/25 transition-colors text-center border border-terminal-purple/30 disabled:opacity-50"
            >
              {gistPublishing ? "Publishing..." : "Publish to Gist"}
            </button>
          )}
          {publishGist && ghAvailable === false && (
            <div className="text-[9px] font-mono text-terminal-orange/70 text-center px-2 py-1.5 border border-terminal-orange/20 rounded bg-terminal-orange/5">
              Gist publishing requires{" "}
              <a
                href="https://cli.github.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                gh CLI
              </a>{" "}
              — install then run <span className="text-terminal-text/70">gh auth login</span>
            </div>
          )}

          {/* Non-editor: client-side actions */}
          {!exportHtml && canSaveHtml && (
            <button
              onClick={downloadHtml}
              className="w-full px-2 py-1.5 text-[10px] font-mono bg-terminal-green/15 text-terminal-green rounded hover:bg-terminal-green/25 transition-colors text-center border border-terminal-green/30"
              title="Download HTML with comments embedded"
            >
              Save HTML with Comments
            </button>
          )}
          {!exportHtml && !canSaveHtml && (
            <div className="text-[9px] font-mono text-terminal-dim/60 text-center px-2 py-1">
              Save HTML requires a production build (use CLI output)
            </div>
          )}
          {!publishGist && (
            <button
              onClick={downloadJson}
              className="w-full px-2 py-1.5 text-[10px] font-mono bg-terminal-blue/10 text-terminal-blue rounded hover:bg-terminal-blue/20 transition-colors text-center border border-terminal-blue/20"
              title="Download replay.json for re-publishing to gist"
            >
              Export JSON (for gist re-publish)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const AnnotationCard = memo(function AnnotationCard({
  annotation,
  scene,
  isCurrent,
  isEditing,
  editBody,
  editTextareaRef,
  onSeek,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onEditBodyChange,
  onDelete,
  readOnly = false,
}: {
  annotation: Annotation;
  scene?: Scene;
  isCurrent: boolean;
  isEditing: boolean;
  editBody: string;
  editTextareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onSeek: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onEditBodyChange: (body: string) => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const [showActions, setShowActions] = useState(false);

  const preview = scene ? scenePreview(scene) : null;
  const labelColor = scene ? sceneLabelColor(scene) : "text-terminal-dim";

  const timeStr = useMemo(() => {
    try {
      return new Date(annotation.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, [annotation.createdAt]);

  const isAiFeedback = annotation.author === "vibe-feedback";

  return (
    <div
      data-annotation-scene={annotation.sceneIndex}
      className={`px-3 py-2 border-b border-terminal-border/30 transition-colors ${
        isAiFeedback
          ? isCurrent
            ? "bg-terminal-purple/10 border-l-2 border-l-terminal-purple"
            : "bg-terminal-purple/[0.03] hover:bg-terminal-purple/[0.06]"
          : isCurrent
            ? "bg-terminal-blue/10 border-l-2 border-l-terminal-blue"
            : "hover:bg-terminal-surface/50"
      }`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* AI Feedback badge */}
      {isAiFeedback && (
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-terminal-purple px-1.5 py-0.5 rounded border border-terminal-purple/30 bg-terminal-purple/10">
            AI Coach
          </span>
        </div>
      )}

      {/* Scene reference — click to navigate */}
      <button
        onClick={onSeek}
        className="flex items-center gap-1.5 mb-1 w-full text-left group/ref"
      >
        {preview && (
          <>
            <span
              className={`text-[10px] font-mono font-semibold uppercase shrink-0 ${labelColor}`}
            >
              {preview.label}
            </span>
            <span className="text-[10px] font-mono text-terminal-dim truncate group-hover/ref:text-terminal-text transition-colors">
              {preview.text}
            </span>
          </>
        )}
        {!preview && (
          <span className="text-[10px] font-mono text-terminal-dim">
            Step {annotation.sceneIndex + 1}
          </span>
        )}
      </button>

      {/* Comment body + actions */}
      <div className="flex items-start gap-1">
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div>
              <textarea
                ref={editTextareaRef}
                value={editBody}
                onChange={(e) => onEditBodyChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    onSaveEdit();
                  }
                  if (e.key === "Escape") onCancelEdit();
                }}
                className="w-full bg-terminal-surface border border-terminal-border/50 rounded px-2 py-1.5 text-xs font-mono text-terminal-text resize-none focus:outline-none focus:border-terminal-blue/50"
                rows={3}
              />
              <div className="flex justify-end gap-1.5 mt-1">
                <button
                  onClick={onCancelEdit}
                  className="px-2 py-0.5 text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={onSaveEdit}
                  className="px-2 py-0.5 text-[10px] font-mono bg-terminal-blue/15 text-terminal-blue rounded hover:bg-terminal-blue/25 transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div
              className="prose-terminal text-xs text-terminal-text/90 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: marked.parse(annotation.body) as string }}
            />
          )}
        </div>

        {/* Action buttons */}
        {!readOnly && showActions && !isEditing && (
          <div className="flex gap-0.5 shrink-0 pt-0.5">
            <button
              onClick={onStartEdit}
              className="p-0.5 text-[10px] text-terminal-dim hover:text-terminal-blue transition-colors"
              title="Edit"
            >
              {"\u270E"}
            </button>
            <button
              onClick={onDelete}
              className="p-0.5 text-[10px] text-terminal-dim hover:text-terminal-red transition-colors"
              title="Delete"
            >
              {"\u2715"}
            </button>
          </div>
        )}
      </div>

      {/* Timestamp */}
      <div className="text-[9px] font-mono text-terminal-dim/40 mt-1">{timeStr}</div>
    </div>
  );
});
