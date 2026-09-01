import { marked } from "marked";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, Scene } from "../types";
import { sanitizeHtml } from "../utils/sanitize";
import { sceneToneTextClass } from "../utils/scene-colors";

// Configure marked for short-form annotation text
marked.setOptions({ breaks: true, gfm: true });

import type { AnnotationActions } from "../hooks/useAnnotations";

interface Props {
  actions: AnnotationActions;
  scenes: Scene[];
  currentIndex: number;
  onSeek: (index: number) => void;
  onSelectAnnotation?: (annotationId: string) => void;
  addingForScene: number | null;
  addingSelectedText?: string | null;
  addingSelectedTextStart?: number | null;
  addingSelectedTextEnd?: number | null;
  focusedAnnotationId?: string | null;
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
    case "context-injection":
      return { label: "Injection", text: scene.content.slice(0, 80) };
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
  return sceneToneTextClass(scene);
}

export default function AnnotationPanel({
  actions,
  scenes,
  currentIndex,
  onSeek,
  onSelectAnnotation,
  addingForScene,
  addingSelectedText = null,
  addingSelectedTextStart = null,
  addingSelectedTextEnd = null,
  focusedAnnotationId = null,
  onClearAddingTarget,
  readOnly = false,
}: Props) {
  const { annotations, add, update, remove } = actions;
  const [internalAdding, setInternalAdding] = useState<number | null>(null);
  const [newBody, setNewBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const addFormRef = useRef<HTMLDivElement>(null);

  // External target from clicking a card's comment icon
  const activeAdding = addingForScene ?? internalAdding;
  const activeSelectedText = addingForScene !== null ? addingSelectedText : null;
  const activeSelectedTextStart = addingForScene !== null ? addingSelectedTextStart : null;
  const activeSelectedTextEnd = addingForScene !== null ? addingSelectedTextEnd : null;

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
    if (focusedAnnotationId) {
      const focused = panelRef.current.querySelector(
        `[data-annotation-id="${CSS.escape(focusedAnnotationId)}"]`,
      );
      if (focused instanceof HTMLElement) {
        focused.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
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
  }, [currentIndex, activeAdding, focusedAnnotationId]);

  const cancelAdding = useCallback(() => {
    setInternalAdding(null);
    setNewBody("");
    onClearAddingTarget();
  }, [onClearAddingTarget]);

  const handleAdd = useCallback(() => {
    if (!newBody.trim() || activeAdding === null) return;
    add(
      activeAdding,
      newBody.trim(),
      activeSelectedText ?? undefined,
      activeSelectedTextStart ?? undefined,
      activeSelectedTextEnd ?? undefined,
    );
    setNewBody("");
    setInternalAdding(null);
    onClearAddingTarget();
  }, [
    add,
    activeAdding,
    activeSelectedText,
    activeSelectedTextEnd,
    activeSelectedTextStart,
    newBody,
    onClearAddingTarget,
  ]);

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
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border-subtle">
        <span className="text-[10px] font-sans font-semibold text-terminal-text uppercase tracking-widest">
          Comments
        </span>
        <div className="flex items-center gap-2">
          {readOnly && (
            <span className="text-xs font-mono text-terminal-dimmer uppercase px-1.5 py-0.5 rounded bg-terminal-surface">
              Read-only
            </span>
          )}
          <span className="text-xs font-mono text-terminal-dim">{annotations.length}</span>
        </div>
      </div>

      {/* Annotation list */}
      <div ref={panelRef} className="flex-1 overflow-y-auto">
        {sorted.length === 0 && activeAdding === null && (
          <div className="px-3 py-8 text-center">
            <div className="text-terminal-dim text-xs font-mono mb-2">No comments yet</div>
            {!readOnly && (
              <div className="text-terminal-dimmer text-xs font-mono">
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
            isFocused={annotation.id === focusedAnnotationId}
            editBody={editingId === annotation.id ? editBody : ""}
            editTextareaRef={editingId === annotation.id ? editTextareaRef : undefined}
            onSelect={() => onSelectAnnotation?.(annotation.id) ?? onSeek(annotation.sceneIndex)}
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
            className="px-3 py-2.5 border-b border-terminal-border-subtle bg-terminal-blue-subtle"
          >
            {/* Scene preview */}
            {addingPreview && (
              <div className="flex items-center gap-1.5 mb-2">
                <span className={`text-xs font-mono font-semibold uppercase ${addingLabelColor}`}>
                  {addingPreview.label}
                </span>
                <span className="text-xs font-mono text-terminal-dim truncate">
                  {addingPreview.text}
                </span>
              </div>
            )}
            {activeSelectedText && (
              <div className="mb-2 rounded-md border border-terminal-blue/20 bg-terminal-blue-subtle/40 px-2 py-1.5">
                <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-terminal-blue mb-1">
                  Selected text
                </div>
                <div className="text-xs font-mono text-terminal-text/85 max-h-20 overflow-hidden whitespace-pre-wrap break-words">
                  {activeSelectedText}
                </div>
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
              className="w-full bg-terminal-surface rounded px-2 py-1.5 text-xs font-mono text-terminal-text placeholder-terminal-dimmer resize-none focus:outline-none ring-1 ring-terminal-border-subtle focus:ring-terminal-blue/40 transition-shadow duration-200"
              rows={3}
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-xs font-mono text-terminal-dimmer">
                {"\u2318"}+Enter to save
              </span>
              <div className="flex gap-1.5">
                <button
                  onClick={cancelAdding}
                  className="px-2 py-1 text-xs font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  disabled={!newBody.trim()}
                  className="px-2 py-1 text-xs font-mono bg-terminal-blue-subtle text-terminal-blue rounded hover:bg-terminal-blue-emphasis transition-colors disabled:opacity-40"
                >
                  Comment
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const AnnotationCard = memo(function AnnotationCard({
  annotation,
  scene,
  isCurrent,
  isFocused,
  isEditing,
  editBody,
  editTextareaRef,
  onSelect,
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
  isFocused: boolean;
  isEditing: boolean;
  editBody: string;
  editTextareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onSelect: () => void;
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
      data-annotation-id={annotation.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- item contains a nested action button; a real <button> would be invalid nested HTML
      role="button"
      tabIndex={0}
      className={`cursor-pointer px-3 py-2 border-b border-terminal-border-subtle transition-colors ${
        isAiFeedback
          ? isCurrent
            ? "bg-terminal-purple/10"
            : "bg-terminal-purple/[0.03] hover:bg-terminal-purple/[0.06]"
          : isFocused
            ? "bg-terminal-blue/15 shadow-[inset_0_0_0_1px_rgba(96,165,250,0.16)]"
            : isCurrent
              ? "bg-terminal-blue/10"
              : "hover:bg-terminal-surface/50"
      }`}
      onClick={() => {
        if (!isEditing) onSelect();
      }}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !isEditing) {
          event.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* AI Feedback badge */}
      {isAiFeedback && (
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[10px] font-sans font-semibold uppercase tracking-widest text-terminal-purple px-2 py-0.5 rounded-full bg-terminal-purple-subtle">
            AI Coach
          </span>
        </div>
      )}

      {/* Scene reference — click to navigate */}
      <button
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        className="flex items-center gap-1.5 mb-1 w-full text-left group/ref"
      >
        {preview && (
          <>
            <span className={`text-xs font-mono font-semibold uppercase shrink-0 ${labelColor}`}>
              {preview.label}
            </span>
            <span className="text-xs font-mono text-terminal-dim truncate group-hover/ref:text-terminal-text transition-colors">
              {preview.text}
            </span>
          </>
        )}
        {!preview && (
          <span className="text-xs font-mono text-terminal-dim">
            Step {annotation.sceneIndex + 1}
          </span>
        )}
      </button>

      {/* Comment body + actions */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {annotation.selectedText && (
            <blockquote
              title={annotation.selectedText}
              className="mb-2 max-h-11 overflow-hidden rounded-md border border-terminal-blue/20 bg-terminal-blue-subtle/30 px-2 py-1.5 text-xs font-mono text-terminal-text/80 whitespace-pre-wrap break-words"
            >
              {annotation.selectedText}
            </blockquote>
          )}
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
                className="w-full bg-terminal-surface rounded px-2 py-1.5 text-xs font-mono text-terminal-text resize-none focus:outline-none ring-1 ring-terminal-border-subtle focus:ring-terminal-blue/40 transition-shadow duration-200"
                rows={3}
              />
              <div className="flex justify-end gap-1.5 mt-1">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEdit();
                  }}
                  className="px-2 py-0.5 text-xs font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onSaveEdit();
                  }}
                  className="px-2 py-0.5 text-xs font-mono bg-terminal-blue-subtle text-terminal-blue rounded hover:bg-terminal-blue-emphasis transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div
              className="prose-terminal text-xs text-terminal-text leading-relaxed"
              dangerouslySetInnerHTML={{
                __html: sanitizeHtml(marked.parse(annotation.body) as string),
              }}
            />
          )}
        </div>

        {/* Action buttons */}
        {!readOnly && !isEditing && (
          <div
            className={`flex w-10 shrink-0 justify-end gap-0.5 pt-0.5 transition-opacity ${
              showActions ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <button
              onClick={(event) => {
                event.stopPropagation();
                onStartEdit();
              }}
              className="p-0.5 text-xs text-terminal-dim hover:text-terminal-blue transition-colors"
              title="Edit"
            >
              {"\u270E"}
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              className="p-0.5 text-xs text-terminal-dim hover:text-terminal-red transition-colors"
              title="Delete"
            >
              {"\u2715"}
            </button>
          </div>
        )}
      </div>

      {/* Timestamp */}
      <div className="text-xs font-mono text-terminal-dimmer mt-1">{timeStr}</div>
    </div>
  );
});
