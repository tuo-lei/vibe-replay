import { useEffect } from "react";
import type { AnnotationActions } from "../hooks/useAnnotations";
import type { OverlayActions } from "../hooks/useOverlays";
import AiStudioPanel from "./AiStudioPanel";

interface Props {
  open: boolean;
  onClose: () => void;
  annotationActions: AnnotationActions;
  overlayActions: OverlayActions;
}

export default function AiStudioDrawer({
  open,
  onClose,
  annotationActions,
  overlayActions,
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
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div
        className={`absolute top-0 right-0 bottom-0 w-96 bg-terminal-bg border-l border-terminal-border-subtle shadow-layer-xl flex flex-col transition-transform duration-300 ease-material-decel ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 z-10 p-1 text-terminal-dim hover:text-terminal-text transition-colors"
          title="Close AI Studio"
        >
          {"\u2715"}
        </button>

        <AiStudioPanel annotationActions={annotationActions} overlayActions={overlayActions} />
      </div>
    </div>
  );
}
