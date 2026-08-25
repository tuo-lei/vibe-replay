/** Build API URL with slug query param when viewing a different session */
export function apiUrl(path: string): string {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("session");
  const targetId = params.get("targetId");
  const query = new URLSearchParams();
  if (slug) query.set("slug", slug);
  if (targetId && targetId !== "local" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(targetId)) {
    query.set("targetId", targetId);
  }
  if (query.size === 0) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${query.toString()}`;
}
