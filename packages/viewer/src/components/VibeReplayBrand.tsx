/** The terminal mark used by the website favicon, shared with the local dashboard. */
export function VibeReplayBrand() {
  return (
    <span className="vibe-replay-brand">
      <svg viewBox="0 0 32 32" aria-hidden="true" fill="none">
        <rect width="32" height="32" rx="6" fill="var(--surface)" />
        <path
          d="m8 11 4 5-4 5M15 21h9"
          stroke="var(--green)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>vibe-replay</span>
    </span>
  );
}
