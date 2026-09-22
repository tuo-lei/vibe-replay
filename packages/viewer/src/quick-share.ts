export interface QuickShareViewer {
  id: string;
  name: string;
}

export interface QuickShareInfo {
  url: string;
  sizeBytes: number;
  maxBytes: number;
  startedAt?: string;
  viewers: QuickShareViewer[];
}

interface QuickShareFallbacks {
  sizeBytes?: number;
  maxBytes?: number;
}

/** Parse the local Quick Share status response without trusting API JSON shapes. */
export function parseQuickShareInfo(
  value: unknown,
  fallbacks: QuickShareFallbacks = {},
): QuickShareInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.active !== true || typeof record.url !== "string") return null;

  const viewers = Array.isArray(record.viewers)
    ? record.viewers.flatMap((viewer) => {
        if (typeof viewer !== "object" || viewer === null) return [];
        const item = viewer as Record<string, unknown>;
        return typeof item.id === "string" && typeof item.name === "string"
          ? [{ id: item.id, name: item.name }]
          : [];
      })
    : [];

  return {
    url: record.url,
    sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : (fallbacks.sizeBytes ?? 0),
    maxBytes: typeof record.maxBytes === "number" ? record.maxBytes : (fallbacks.maxBytes ?? 0),
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    viewers,
  };
}
