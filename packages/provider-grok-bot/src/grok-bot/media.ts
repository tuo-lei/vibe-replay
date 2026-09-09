/**
 * Grok Bot tool results (generate_image, computer_use screenshots) embed
 * multi-MB base64 payloads next to a filePath/screenshotPath. Replay HTML
 * must stay usable, so strip/truncate binary fields and keep the path.
 *
 * Markdown `![alt](<file:///home/box/...>)` images are rewritten to a path
 * mention. Shareable HTML cannot load `file://` and this repo has no bundle
 * step for those attachments; inlining would reintroduce the size problem.
 */

const MEDIA_KEYS = new Set([
  "imagedata",
  "image_data",
  "screenshot",
  "screenshotdata",
  "screenshot_data",
  "thumbnail",
  "thumbnaildata",
  "thumbnail_data",
]);

const PATH_KEYS = new Set([
  "filepath",
  "file_path",
  "path",
  "screenshotpath",
  "screenshot_path",
  "imagepath",
  "image_path",
]);

const MARKDOWN_FILE_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?(file:\/\/[^)\s>]+)>?\s*\)/gi;
const MARKDOWN_DATA_IMAGE_RE = /!\[([^\]]*)\]\(\s*data:image\/[^)]+\)/gi;
const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

export function omittedMediaPlaceholder(label: string, length: number): string {
  return `[omitted ${label}, ${length} chars]`;
}

export function looksLikeBase64Payload(value: string): boolean {
  if (DATA_URL_RE.test(value) && value.length > 80) return true;
  const compact = value.replace(/\s+/g, "");
  return compact.length >= 200 && /^[A-Za-z0-9+/]+=*$/.test(compact);
}

export function scrubGrokBotMediaPayload(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") {
    return looksLikeBase64Payload(value)
      ? omittedMediaPlaceholder("binary payload", value.length)
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => scrubGrokBotMediaPayload(item, depth + 1));
  if (typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (typeof item === "string" && MEDIA_KEYS.has(lower) && item.length > 80) {
      out[key] = omittedMediaPlaceholder(key, item.length);
      continue;
    }
    if (typeof item === "string" && looksLikeBase64Payload(item) && !PATH_KEYS.has(lower)) {
      out[key] = omittedMediaPlaceholder(key, item.length);
      continue;
    }
    out[key] = scrubGrokBotMediaPayload(item, depth + 1);
  }
  return out;
}

export function mediaPathFromPayload(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of [
    "filePath",
    "file_path",
    "screenshotPath",
    "screenshot_path",
    "imagePath",
    "image_path",
    "path",
  ]) {
    const item = obj[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return undefined;
}

/**
 * Best-effort rewrite so markdown images do not become broken `<img src>` tags
 * in shareable HTML. Local files are not inlined.
 */
export function rewriteGrokBotShareableText(text: string): string {
  return text
    .replace(MARKDOWN_FILE_IMAGE_RE, (_match, alt: string, url: string) => {
      const label = (alt || "image").trim() || "image";
      const path = stripFileUrl(url);
      return `[image: ${label} — ${path}]`;
    })
    .replace(MARKDOWN_DATA_IMAGE_RE, (_match, alt: string) => {
      const label = (alt || "embedded").trim() || "embedded";
      return `[image: ${label}]`;
    });
}

function stripFileUrl(url: string): string {
  const trimmed = url.trim();
  try {
    return decodeURIComponent(trimmed.replace(/^file:\/\//i, ""));
  } catch {
    return trimmed.replace(/^file:\/\//i, "");
  }
}
