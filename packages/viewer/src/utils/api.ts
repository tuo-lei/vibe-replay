/** Build API URL with slug query param when viewing a different session */
export function apiUrl(path: string): string {
  const slug = new URLSearchParams(window.location.search).get("session");
  if (!slug) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}slug=${encodeURIComponent(slug)}`;
}
