import { useEffect } from "react";
import type { AnnotationActions } from "../hooks/useAnnotations";
import type { Scene } from "../types";
import AnnotationPanel from "./AnnotationPanel";

interface Props {
  open: boolean;
  onClose: () => void;
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

export default function CommentDrawer({
  open,
  onClose,
  actions,
  scenes,
  currentIndex,
  onSeek,
  onSelectAnnotation,
  addingForScene,
  addingSelectedText,
  addingSelectedTextStart,
  addingSelectedTextEnd,
  focusedAnnotationId,
  onClearAddingTarget,
  readOnly,
}: Props) {
  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 hidden md:block transition-opacity duration-300 ${
        open ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />

      {/* Panel */}
      <aside
        className={`absolute top-0 right-0 bottom-0 w-80 bg-terminal-bg border-l border-terminal-border-subtle shadow-layer-xl flex flex-col transition-transform duration-300 ease-material-decel ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 z-10 p-1 text-terminal-dim hover:text-terminal-text transition-colors"
          title="Close comments"
        >
          {"\u2715"}
        </button>

        <AnnotationPanel
          actions={actions}
          scenes={scenes}
          currentIndex={currentIndex}
          onSeek={onSeek}
          onSelectAnnotation={onSelectAnnotation}
          addingForScene={addingForScene}
          addingSelectedText={addingSelectedText}
          addingSelectedTextStart={addingSelectedTextStart}
          addingSelectedTextEnd={addingSelectedTextEnd}
          focusedAnnotationId={focusedAnnotationId}
          onClearAddingTarget={onClearAddingTarget}
          readOnly={readOnly}
        />
      </aside>
    </div>
  );
}
