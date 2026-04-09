import { useCallback, useMemo, useRef } from "react";
import type { Scene } from "../types";

interface Props {
  scenes: Scene[];
  currentIndex: number;
  onSeek: (index: number) => void;
  annotatedScenes?: Set<number>;
}

function sceneColor(type: Scene["type"]): string {
  switch (type) {
    case "user-prompt":
      return "#3fb950";
    case "compaction-summary":
      return "#666666";
    case "context-injection":
      return "#4488cc";
    case "thinking":
      return "#b392f0";
    case "text-response":
      return "#79b8ff";
    case "tool-call":
      return "#d29922";
  }
}

export default function Timeline({ scenes, currentIndex, onSeek, annotatedScenes }: Props) {
  // For large sessions (>200 scenes), bucket into segments to avoid rendering 700+ divs
  const segments = useMemo(() => {
    const maxSegments = 200;
    if (scenes.length <= maxSegments) {
      return scenes.map((s, i) => ({
        startIndex: i,
        endIndex: i,
        type: s.type,
      }));
    }

    const bucketSize = scenes.length / maxSegments;
    const result: { startIndex: number; endIndex: number; type: Scene["type"] }[] = [];
    for (let b = 0; b < maxSegments; b++) {
      const start = Math.floor(b * bucketSize);
      const end = Math.floor((b + 1) * bucketSize) - 1;
      // Use the most "interesting" type in the bucket (user > tool > text > thinking)
      const typePriority: Record<Scene["type"], number> = {
        "user-prompt": 4,
        "compaction-summary": 1,
        "context-injection": 1,
        "tool-call": 3,
        "text-response": 2,
        thinking: 1,
      };
      let bestType = scenes[start].type;
      let bestPriority = typePriority[bestType];
      for (let i = start + 1; i <= end && i < scenes.length; i++) {
        const p = typePriority[scenes[i].type];
        if (p > bestPriority) {
          bestType = scenes[i].type;
          bestPriority = p;
        }
      }
      result.push({ startIndex: start, endIndex: end, type: bestType });
    }
    return result;
  }, [scenes]);

  const progressPct = scenes.length > 0 ? ((currentIndex + 1) / scenes.length) * 100 : 0;

  const barRef = useRef<HTMLDivElement>(null);

  const handleSeekClick = useCallback(
    (e: React.MouseEvent) => {
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));
      const idx = Math.floor(pct * scenes.length);
      onSeek(idx);
    },
    [scenes.length, onSeek],
  );

  // Compute annotation dot positions
  const annotationDots = useMemo(() => {
    if (!annotatedScenes || annotatedScenes.size === 0) return [];
    const dots: number[] = [];
    annotatedScenes.forEach((idx) => {
      if (idx >= 0 && idx < scenes.length) {
        dots.push(((idx + 0.5) / scenes.length) * 100);
      }
    });
    return dots;
  }, [annotatedScenes, scenes.length]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        onSeek(Math.min(currentIndex + 1, scenes.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        onSeek(Math.max(currentIndex - 1, 0));
      } else if (e.key === "Home") {
        e.preventDefault();
        onSeek(0);
      } else if (e.key === "End") {
        e.preventDefault();
        onSeek(scenes.length - 1);
      }
    },
    [currentIndex, scenes.length, onSeek],
  );

  if (scenes.length === 0) return null;

  return (
    <div
      className="px-4 pt-3 pb-1 cursor-pointer"
      onClick={handleSeekClick}
      onKeyDown={handleKeyDown}
      role="slider"
      aria-label="Scene timeline"
      aria-valuemin={0}
      aria-valuemax={scenes.length - 1}
      aria-valuenow={currentIndex}
      tabIndex={0}
    >
      {/* Annotation dots above timeline */}
      {annotationDots.length > 0 && (
        <div className="relative h-2 mb-0.5">
          {annotationDots.map((pct, i) => (
            <div
              key={i}
              className="absolute w-1.5 h-1.5 rounded-full bg-terminal-blue shadow-layer-sm"
              style={{ left: `${pct}%`, top: "50%", transform: "translate(-50%, -50%)" }}
            />
          ))}
        </div>
      )}
      <div
        ref={barRef}
        className="relative flex h-2 rounded-full overflow-hidden bg-terminal-surface-2"
      >
        {segments.map((seg, i) => (
          <div
            key={i}
            className="flex-1 transition-opacity duration-150"
            style={{
              backgroundColor: sceneColor(seg.type),
              opacity: seg.startIndex <= currentIndex ? 1 : 0.15,
            }}
          />
        ))}
        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-layer-sm transition-[left] duration-150 ease-material"
          style={{ left: `${progressPct}%` }}
        />
      </div>
    </div>
  );
}
