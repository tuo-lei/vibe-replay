import { useState } from "react";

interface Props {
  src: string;
  alt: string;
  className: string;
}

function isEmbeddedImage(src: string): boolean {
  return /^data:image\//i.test(src);
}

function externalHost(src: string): string | undefined {
  try {
    const url = new URL(src);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** Render embedded images immediately, but require consent before loading any external source. */
export default function ReplayImage({ src, alt, className }: Props) {
  const embedded = isEmbeddedImage(src);
  const host = externalHost(src);
  const [approvedSource, setApprovedSource] = useState<string>();
  const [failedSource, setFailedSource] = useState<string>();
  const externalLoadApproved = approvedSource === src;
  const failed = failedSource === src;

  if (!embedded && !externalLoadApproved) {
    if (!host) {
      return (
        <div className="max-w-[300px] rounded-md border border-terminal-border px-3 py-2 font-mono text-xs text-terminal-dim">
          Unsupported image source
        </div>
      );
    }
    return (
      <div className="max-w-[300px] rounded-md border border-dashed border-terminal-border px-3 py-2 font-mono text-xs text-terminal-dim">
        <div>External image blocked</div>
        <button
          type="button"
          onClick={() => setApprovedSource(src)}
          className="mt-1 text-terminal-blue hover:text-terminal-text transition-colors"
        >
          Load external image
        </button>
        <div className="mt-1 text-[10px] text-terminal-dimmer">This will contact {host}.</div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="max-w-[300px] rounded-md border border-terminal-border px-3 py-2 font-mono text-xs text-terminal-dim">
        External image unavailable
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      referrerPolicy={embedded ? undefined : "no-referrer"}
      onError={() => setFailedSource(src)}
    />
  );
}
