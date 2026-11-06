#!/usr/bin/env python3
"""Check PR reviews + CI status for a vibe-replay PR (stored credential)."""
import json
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

API = "https://api.github.com"
PR = sys.argv[1] if len(sys.argv) > 1 else "747"
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
        print(f"HTTP {exc.code} on {path}: {exc.read().decode('utf-8', 'replace')[:200]}", file=sys.stderr)
        return None


pr = api(f"/repos/tuo-lei/vibe-replay/pulls/{PR}")
if not pr:
    sys.exit(1)
head = pr["head"]["sha"]
print(json.dumps({"state": pr["state"], "mergeable": pr.get("mergeable"), "head": head[:7], "base": pr["base"]["sha"][:7]}, indent=1))

reviews = api(f"/repos/tuo-lei/vibe-replay/pulls/{PR}/reviews?per_page=50") or []
for r in reviews:
    print(json.dumps({"reviewer": r["user"]["login"], "state": r["state"], "submitted": r["submitted_at"], "body_len": len(r["body"] or "")}))
comments = api(f"/repos/tuo-lei/vibe-replay/pulls/{PR}/comments?per_page=50") or []
for c in comments:
    print(json.dumps({"inline": True, "author": c["user"]["login"], "path": c["path"], "created": c["created_at"], "body": (c["body"] or "")[:300]}))

combined = api(f"/repos/tuo-lei/vibe-replay/commits/{head}/status")
if combined:
    print(json.dumps({"ci_state": combined.get("state"), "statuses": [(s["context"], s["state"]) for s in combined.get("statuses", [])]}))
checks = api(f"/repos/tuo-lei/vibe-replay/commits/{head}/check-runs?per_page=50") or {}
for cr in checks.get("check_runs", []):
    print(json.dumps({"check": cr["name"], "status": cr["status"], "conclusion": cr["conclusion"]}))
