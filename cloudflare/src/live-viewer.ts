/**
 * Minimal E2E viewer page for `vibe-replay relay` share URLs.
 *
 * Served at `/live/<boxId>` (non-WebSocket GET). All crypto happens here in
 * the browser: the content key is read from the URL fragment
 * (`location.hash`) and never leaves the device. The page opens a WebSocket to
 * the same path, says hello as `viewer`, and exchanges AES-256-GCM encrypted
 * frames with the VM shipper. The relay only forwards ciphertext.
 *
 * This is intentionally slim — it mirrors the share/list/read/search/tail
 * command set. Wiring the full animated viewer is a follow-up.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderLiveViewerPage(boxId: string): string {
  const safeBoxId = esc(boxId);
  // NOTE: inside the inline script we avoid `</` sequences entirely
  // (repo rule: browsers would close the script tag).
  const script = `
"use strict";
var BOX_ID = ${JSON.stringify(boxId)};
var keyB64 = (location.hash || "").replace(/^#/, "");
var key = null;
var ws = null;
var seq = 0;
var pending = {};
var tailTimer = null;
var currentSession = null;

function $(id) { return document.getElementById(id); }

function b64urlEncode(bytes) {
  var s = btoa(String.fromCharCode.apply(null, bytes));
  return s.replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function aad() { return new TextEncoder().encode("vibe-replay-live:v1:" + BOX_ID); }

function setStatus(t, bad) {
  var el = $("status");
  el.textContent = t;
  el.style.color = bad ? "#f87171" : "#9ca3af";
}

function sendFrame(payload) {
  var pt = new TextEncoder().encode(JSON.stringify(payload));
  var iv = crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: aad() }, key, pt)
    .then(function (ct) {
      ws.send(JSON.stringify({ t: "frame", iv: b64urlEncode(iv), data: b64urlEncode(new Uint8Array(ct)) }));
    });
}
function decryptFrame(ivB64, dataB64) {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(ivB64), additionalData: aad() },
    key, b64urlDecode(dataB64)
  ).then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
}
function cmd(obj) {
  return new Promise(function (resolve, reject) {
    seq += 1;
    obj.seq = seq;
    pending[seq] = { resolve: resolve, reject: reject };
    sendFrame(obj).catch(reject);
    setTimeout(function () {
      if (pending[obj.seq]) { delete pending[obj.seq]; reject(new Error("timeout")); }
    }, 30000);
  });
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso || ""; }
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderList(sessions) {
  var html = "";
  sessions.forEach(function (s, i) {
    html += '<div class="sess" data-i="' + i + '">'
      + '<div class="t">' + escHtml(s.title || s.sessionId.slice(0, 12)) + '</div>'
      + '<div class="m">' + escHtml(s.provider) + " · " + escHtml(fmtTime(s.timestamp))
      + (s.promptCount != null ? " · " + s.promptCount + " prompts" : "") + '</div>'
      + "</div>";
  });
  $("list").innerHTML = html || '<div class="empty">No sessions found on this machine.</div>';
  var nodes = document.querySelectorAll(".sess");
  nodes.forEach(function (n) {
    n.onclick = function () { openSession(sessions[+n.getAttribute("data-i")]); };
  });
}

function sceneLabel(type) {
  var map = {
    "user-prompt": "You", "text-response": "Assistant", "thinking": "Thinking",
    "tool-call": "Tool", "compaction-summary": "Compaction", "context-injection": "Context"
  };
  return map[type] || type;
}
function sceneBody(sc) {
  if (typeof sc.content === "string") return sc.content;
  if (typeof sc.result === "string") return sc.result;
  if (typeof sc.prompt === "string") return sc.prompt;
  return JSON.stringify(sc).slice(0, 2000);
}
function renderScenes(scenes) {
  var html = "";
  scenes.forEach(function (sc) {
    html += '<div class="scene"><div class="sl">' + escHtml(sceneLabel(sc.type)) + '</div>'
      + '<pre>' + escHtml(sceneBody(sc)).slice(0, 8000) + '</pre></div>';
  });
  return html;
}

function openSession(s) {
  currentSession = s;
  setStatus("Loading session…");
  $("detailTitle").textContent = s.title || s.sessionId.slice(0, 12);
  $("detailMeta").textContent = s.provider + " · " + fmtTime(s.timestamp);
  $("listWrap").style.display = "none";
  $("detailWrap").style.display = "block";
  $("scenes").innerHTML = "";
  cmd({ cmd: "get", id: s.sessionId }).then(function (res) {
    if (!res.ok) { setStatus("Error: " + res.error, true); return; }
    setStatus("E2E-encrypted · " + res.data.totalScenes + " scenes");
    $("scenes").innerHTML = renderScenes(res.data.scenes);
  }).catch(function (e) { setStatus("Error: " + e.message, true); });
}
function backToList() {
  stopTail();
  currentSession = null;
  $("detailWrap").style.display = "none";
  $("listWrap").style.display = "block";
  refreshList();
}
function refreshList() {
  setStatus("Loading sessions…");
  cmd({ cmd: "list" }).then(function (res) {
    if (!res.ok) { setStatus("Error: " + res.error, true); return; }
    setStatus("E2E-encrypted · " + res.data.sessions.length + " sessions");
    renderList(res.data.sessions);
  }).catch(function (e) { setStatus("Error: " + e.message, true); });
}
function doSearch() {
  var q = $("q").value.trim();
  if (!q) { refreshList(); return; }
  setStatus("Searching…");
  cmd({ cmd: "search", q: q, limit: 10 }).then(function (res) {
    if (!res.ok) { setStatus("Error: " + res.error, true); return; }
    setStatus("E2E-encrypted · " + res.data.hits.length + " hits");
    var html = "";
    res.data.hits.forEach(function (h) {
      html += '<div class="sess" data-id="' + escHtml(h.sessionId) + '">'
        + '<div class="t">' + escHtml(h.title || h.sessionId.slice(0, 12)) + '</div>'
        + '<div class="m">' + escHtml(h.provider) + '</div>'
        + '<pre class="snip">' + escHtml(h.snippet) + '</pre></div>';
    });
    $("list").innerHTML = html || '<div class="empty">No matches.</div>';
    document.querySelectorAll(".sess").forEach(function (n) {
      n.onclick = function () {
        var id = n.getAttribute("data-id");
        cmd({ cmd: "list" }).then(function (r) {
          var s = r.data.sessions.filter(function (x) { return x.sessionId === id; })[0];
          if (s) openSession(s);
        });
      };
    });
  }).catch(function (e) { setStatus("Error: " + e.message, true); });
}
function startTail() {
  if (!currentSession) return;
  setStatus("Watching live…");
  cmd({ cmd: "tail", id: currentSession.sessionId }).then(function (res) {
    if (!res.ok) { setStatus("Error: " + res.error, true); return; }
    setStatus("E2E-encrypted · live — new turns appear below");
    $("tailBtn").textContent = "Stop watching";
    $("tailBtn").onclick = stopTail;
  }).catch(function (e) { setStatus("Error: " + e.message, true); });
}
function stopTail() {
  if (currentSession) cmd({ cmd: "untail", id: currentSession.sessionId }).catch(function () {});
  if ($("tailBtn")) { $("tailBtn").textContent = "Watch live"; $("tailBtn").onclick = startTail; }
  if (currentSession) setStatus("E2E-encrypted");
}
function onTailEvent(ev) {
  if (!currentSession || ev.id !== currentSession.sessionId) return;
  var div = document.createElement("div");
  div.innerHTML = renderScenes(ev.newScenes);
  $("scenes").appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}

function connect() {
  setStatus("Connecting…");
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/live/" + BOX_ID);
  ws.onopen = function () {
    ws.send(JSON.stringify({ t: "hello", role: "viewer" }));
    setStatus("Connected — requesting session list…");
    refreshList();
  };
  ws.onmessage = function (e) {
    var outer;
    try { outer = JSON.parse(e.data); } catch (err) { return; }
    if (outer.t !== "frame" || !outer.iv || !outer.data) return;
    decryptFrame(outer.iv, outer.data).then(function (inner) {
      if (inner.event === "tail") { onTailEvent(inner); return; }
      var p = pending[inner.seq];
      if (p) { delete pending[inner.seq]; p.resolve(inner); }
    }).catch(function () { /* not for us */ });
  };
  ws.onclose = function () { setStatus("Disconnected — reload to retry.", true); };
  ws.onerror = function () { setStatus("Connection error.", true); };
}

window.addEventListener("DOMContentLoaded", function () {
  if (!/^[A-Za-z0-9_-]{43}$/.test(keyB64)) {
    setStatus("Invalid share URL: missing encryption key in #fragment.", true);
    return;
  }
  var raw = b64urlDecode(keyB64);
  crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]).then(function (k) {
    key = k;
    if (!window.isSecureContext) setStatus("Warning: not a secure context — WebCrypto may be limited.", true);
    connect();
  }).catch(function () { setStatus("Invalid encryption key.", true); });
  $("backBtn").onclick = backToList;
  $("tailBtn").onclick = startTail;
  $("searchBtn").onclick = doSearch;
  $("q").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
});
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>vibe-replay live — ${safeBoxId}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0e14; color: #e5e7eb; margin: 0; padding: 16px; }
  #bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  #status { font-size: 12px; color: #9ca3af; margin-bottom: 12px; }
  .sess { border: 1px solid #1f2937; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
  .sess:hover { border-color: #374151; background: #111827; }
  .sess .t { font-weight: 600; }
  .sess .m { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .snip { font-size: 12px; color: #9ca3af; white-space: pre-wrap; }
  .empty { color: #6b7280; padding: 24px 0; text-align: center; }
  .scene { border-left: 2px solid #1f2937; padding: 4px 0 4px 12px; margin-bottom: 12px; }
  .sl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 4px; }
  .scene pre { white-space: pre-wrap; word-break: break-word; font-size: 13px; margin: 0; }
  button { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button:hover { background: #374151; }
  input { background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 6px 10px; flex: 1; min-width: 160px; }
  #detailMeta { font-size: 12px; color: #9ca3af; margin: 4px 0 12px; }
  .lock { font-size: 11px; color: #6b7280; margin-top: 16px; }
</style>
</head>
<body>
<div id="bar">
  <strong>vibe-replay live</strong>
  <span style="flex:1"></span>
  <input id="q" placeholder="Search sessions…" />
  <button id="searchBtn">Search</button>
</div>
<div id="status">Starting…</div>
<div id="listWrap"><div id="list"></div></div>
<div id="detailWrap" style="display:none">
  <button id="backBtn">← All sessions</button>
  <button id="tailBtn">Watch live</button>
  <h2 id="detailTitle"></h2>
  <div id="detailMeta"></div>
  <div id="scenes"></div>
</div>
<div class="lock">🔒 End-to-end encrypted — the key stays in this page's URL fragment; the relay only forwards ciphertext.</div>
<script>${script.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;
}
