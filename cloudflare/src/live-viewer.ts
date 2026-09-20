/**
 * Shell page for `vibe-replay relay` share URLs, served at `/live/<boxId>`
 * (non-WebSocket GET).
 *
 * The real UI is the React live viewer (`packages/viewer/src/live/`), built
 * by `pnpm --filter @vibe-replay/viewer build:live` into `website/public/
 * live-app/` and served as a static asset. This shell only bootstraps it.
 *
 * Deliberately zero inline JavaScript: the app reads the box id from
 * `location.pathname` and the content key from the URL fragment
 * (`location.hash`), so there is nothing to inject and no XSS surface.
 * All crypto still happens in the browser; the relay only forwards
 * ciphertext.
 */
export function renderLiveViewerPage(versionId: string): string {
  const v = versionId ? `?v=${encodeURIComponent(versionId)}` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vibe-replay live</title>
<link rel="stylesheet" href="/live-app/live.css${v}" />
</head>
<body>
<div id="root"></div>
<script type="module" src="/live-app/live.js${v}"></script>
</body>
</html>`;
}
