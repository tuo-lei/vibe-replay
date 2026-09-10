/**
 * Grok Bot tool results (generate_image, computer_use screenshots) embed
 * multi-MB base64 payloads next to a filePath/screenshotPath. Replay HTML
 * must stay usable, so strip/truncate binary fields and keep the path.
 *
 * Markdown `![alt](<file:///home/box/...> "title")` images are rewritten to a
 * basename mention. Shareable HTML cannot load `file://` and this repo has no
 * bundle step for those attachments; inlining would reintroduce the size
 * problem. Windows `file:///C:/...` paths are normalized the same way.
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

const MARKDOWN_FILE_IMAGE_RE =
  /!\[([^\]]*)\]\(\s*<?(file:\/\/[^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi;
const MARKDOWN_DATA_IMAGE_RE = /!\[([^\]]*)\]\(\s*(data:image\/[^)]+)\)/gi;
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

/** Last path segment, accepting `/` and `\\` so Windows paths work on POSIX. */
export function grokBotPathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "").trim();
  if (!trimmed) return path.trim() || "image";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || path.trim();
}

/**
 * Rewrite a local/data image into a basename mention. Shareable HTML cannot
 * load `file://`, and inlining the bytes would bloat the replay.
 */
export function formatAttachedImageMention(alt: string, urlOrPath: string): string {
  const path = stripFileUrl(urlOrPath);
  const base = grokBotPathBasename(path);
  const label = alt.trim();
  if (label && base && label !== base) return `[attached image: ${label} (${base})]`;
  return `[attached image: ${base || label || "image"}]`;
}

/**
 * Best-effort rewrite so markdown images do not become broken `<img src>` tags
 * in shareable HTML. Local files are not inlined.
 */
export function rewriteGrokBotShareableText(text: string): string {
  MARKDOWN_FILE_IMAGE_RE.lastIndex = 0;
  MARKDOWN_DATA_IMAGE_RE.lastIndex = 0;
  return text
    .replace(MARKDOWN_FILE_IMAGE_RE, (_match, alt: string, url: string) =>
      formatAttachedImageMention(alt, url),
    )
    .replace(MARKDOWN_DATA_IMAGE_RE, (_match, alt: string) => {
      const label = (alt || "embedded").trim() || "embedded";
      return `[attached image: ${label}]`;
    });
}

export function stripFileUrl(url: string): string {
  const trimmed = url.trim();
  // Any data-image URL (base64 or not) would dump payload into replay text.
  if (/^data:image\//i.test(trimmed)) return "embedded";
  if (/^https?:\/\//i.test(trimmed)) return remoteUrlPath(trimmed);
  let path = trimmed;
  // Windows drive: file:///C:/Users/... or file:///C|\Users\...
  path = path.replace(/^file:\/\/\/([A-Za-z]):/i, "$1:");
  // POSIX absolute: file:///home/box/...
  path = path.replace(/^file:\/\/\/+/i, "/");
  path = path.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Pathname only — signed query/fragment tokens must not enter shareable replays. */
function remoteUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      return parsed.pathname;
    }
  } catch {
    const cut = trimmedQueryAndFragment(url);
    try {
      return decodeURIComponent(cut);
    } catch {
      return cut;
    }
  }
}

function trimmedQueryAndFragment(url: string): string {
  const hash = url.indexOf("#");
  const query = url.indexOf("?");
  const end =
    hash >= 0 && query >= 0 ? Math.min(hash, query) : hash >= 0 ? hash : query >= 0 ? query : -1;
  return end >= 0 ? url.slice(0, end) : url;
}

/**
 * Dedup key for a send_message attachment. Uses the full sanitized path or
 * origin+pathname (query/fragment stripped), not the display basename, so
 * `/a/notes.txt` and `/b/notes.txt` stay distinct. Data-image payloads are
 * keyed by the URL itself and never copied into replay text.
 */
export function grokBotAttachmentIdentity(url?: string, title?: string): string {
  const trimmedUrl = url?.trim() ?? "";
  const trimmedTitle = title?.trim() ?? "";
  if (trimmedUrl && /^data:image\//i.test(trimmedUrl)) return `data:${trimmedUrl}`;
  if (trimmedUrl && /^https?:\/\//i.test(trimmedUrl)) {
    try {
      const parsed = new URL(trimmedUrl);
      return `url:${parsed.origin}${parsed.pathname}`.toLowerCase();
    } catch {
      return `url:${stripFileUrl(trimmedUrl).toLowerCase()}`;
    }
  }
  if (trimmedUrl) {
    return `path:${stripFileUrl(trimmedUrl)
      .replace(/[\\/]+$/, "")
      .toLowerCase()}`;
  }
  if (trimmedTitle) return `title:${trimmedTitle.toLowerCase()}`;
  return "";
}

/** Source identities already present as markdown images in the reply body. */
export function grokBotShareableMediaIdentities(text: string): Set<string> {
  MARKDOWN_FILE_IMAGE_RE.lastIndex = 0;
  MARKDOWN_DATA_IMAGE_RE.lastIndex = 0;
  const ids = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_FILE_IMAGE_RE)) {
    const url = match[2];
    if (url) ids.add(grokBotAttachmentIdentity(url));
  }
  for (const match of text.matchAll(MARKDOWN_DATA_IMAGE_RE)) {
    const url = match[2];
    const alt = match[1];
    if (url) ids.add(grokBotAttachmentIdentity(url, alt));
  }
  return ids;
}
