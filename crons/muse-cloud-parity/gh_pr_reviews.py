#!/usr/bin/env python3
"""Dump full review bodies + inline comments for a PR to a local file."""
import json
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

API = "https://api.github.com"
PR = sys.argv[1] if len(sys.argv) > 1 else "747"
OUT = sys.argv[2] if len(sys.argv) > 2 else f"/home/hatch/workspace/vibe-replay/crons/muse-cloud-parity/pr-{PR}-reviews.md"
TIMEOUT_SECONDS = 30


def api(path: str):
    """GET one api.github.com path with the stored credential, or None on HTTP error."""
    req = urllib.request.Request(API + path, method="GET")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    add_surrogate_to_request(req, "custom.github", allowed_hosts=["api.github.com"])
    try:
        return read_json_response(urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS))
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code} on {path}", file=sys.stderr)
        return None


def api_pages(path: str):
    """GET every page of a paginated api.github.com list (100 per page)."""
    items: list = []
    page = 1
    sep = "&" if "?" in path else "?"
    while True:
        data = api(f"{path}{sep}per_page=100&page={page}")
        if data is None:
            return None
        items.extend(data)
        if len(data) < 100:
            break
        page += 1
    return items


lines: list[str] = []
reviews = api_pages(f"/repos/tuo-lei/vibe-replay/pulls/{PR}/reviews")
if reviews is None:
    print("failed to retrieve reviews; existing dump preserved", file=sys.stderr)
    sys.exit(1)
for r in reviews:
    lines.append(f"## Review by {r['user']['login']} ({r['state']}) at {r['submitted_at']}\n")
    lines.append(r["body"] or "(no body)")
    lines.append("\n---\n")
comments = api_pages(f"/repos/tuo-lei/vibe-replay/pulls/{PR}/comments")
if comments is None:
    print("failed to retrieve inline comments; existing dump preserved", file=sys.stderr)
    sys.exit(1)
for c in comments:
    lines.append(
        f"## Inline by {c['user']['login']} on {c['path']}:{c.get('line') or c.get('original_line')} "
        f"(id {c['id']}) at {c['created_at']}\n"
    )
    lines.append(c["body"] or "")
    lines.append("\n---\n")
with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(f"wrote {OUT} ({len(lines)} blocks)")
