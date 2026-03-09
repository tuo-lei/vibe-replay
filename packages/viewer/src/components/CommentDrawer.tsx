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
  totalScenes: number;
  onSeek: (index: number) => void;
  addingForScene: number | null;
  onClearAddingTarget: () => void;
  readOnly?: boolean;
}

export default function CommentDrawer({
  open,
  onClose,
  actions,
  scenes,
  currentIndex,
  totalScenes,
  onSeek,
  addingForScene,
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
      className={`fixed inset-0 z-30 hidden md:block transition-opacity duration-300 ${
        open ? "opacity-100" : "opacity-0 pointer-events-none"
      }`}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div
        className={`absolute top-0 right-0 bottom-0 w-80 bg-terminal-bg border-l border-terminal-border-subtle shadow-layer-xl flex flex-col transition-transform duration-300 ease-material-decel ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        onClick={(e) => e.stopPropagation()}
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
          totalScenes={totalScenes}
          onSeek={onSeek}
          addingForScene={addingForScene}
          onClearAddingTarget={onClearAddingTarget}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
