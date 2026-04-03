import { useEffect, useRef, useState } from "react";

export function useAnimatedNumber(target: number, durationMs = 450): number {
  const [display, setDisplay] = useState(target);
  const currentRef = useRef(target);

  useEffect(() => {
    const startValue = currentRef.current;
    const delta = target - startValue;
    if (Math.abs(delta) < 1) {
      currentRef.current = target;
      setDisplay(target);
      return;
    }

    let frame = 0;
    const startAt = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startAt) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      const next = startValue + delta * eased;
      currentRef.current = next;
      setDisplay(next);
      if (t < 1) {
        frame = requestAnimationFrame(step);
      } else {
        currentRef.current = target;
        setDisplay(target);
      }
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return display;
}

export function AnimatedValue({
  value,
  formatter = (n) => Math.round(n).toLocaleString(),
}: {
  value: number;
  formatter?: (value: number) => string;
}) {
  const animated = useAnimatedNumber(value);
  return <>{formatter(animated)}</>;
}
