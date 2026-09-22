import { normalizeName } from "./protocol";

export const VIEWER_NAME_STORAGE_KEY = "vibe-replay:viewer-name";

const ADJECTIVES = ["Blue", "Calm", "Bright", "Swift", "Quiet", "Lucky", "Mellow", "Sunny"];
const ANIMALS = ["Otter", "Fox", "Panda", "Koala", "Robin", "Gecko", "Lynx", "Wren"];

export function readStoredViewerName(): string | null {
  try {
    const value = window.localStorage.getItem(VIEWER_NAME_STORAGE_KEY);
    return value && value.trim() ? normalizeName(value) : null;
  } catch {
    return null;
  }
}

export function saveViewerName(raw: string): string {
  const name = normalizeName(raw);
  try {
    window.localStorage.setItem(VIEWER_NAME_STORAGE_KEY, name);
  } catch {
    // Storage may be unavailable; keep the name for this page load.
  }
  return name;
}

export function ensureViewerName(): string {
  const stored = readStoredViewerName();
  if (stored) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const generated = `${ADJECTIVES[bytes[0]! % ADJECTIVES.length]} ${
    ANIMALS[bytes[1]! % ANIMALS.length]
  }`;
  return saveViewerName(generated);
}
