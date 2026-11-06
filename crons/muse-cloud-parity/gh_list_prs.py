#!/usr/bin/env python3
"""List open PRs on tuo-lei/vibe-replay via api.github.com (stored credential)."""
import json
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

API = "https://api.github.com"
req = urllib.request.Request(
    API + "/repos/tuo-lei/vibe-replay/pulls?state=open&per_page=50",
    method="GET",
)
req.add_header("Accept", "application/vnd.github+json")
req.add_header("X-GitHub-Api-Version", "2022-11-28")
add_surrogate_to_request(req, "custom.github", allowed_hosts=["api.github.com"])
try:
    data = read_json_response(urllib.request.urlopen(req))
except urllib.error.HTTPError as exc:
    print(f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}", file=sys.stderr)
    sys.exit(1)
for pr in data:
    print(json.dumps({
        "number": pr["number"],
        "title": pr["title"],
        "head": pr["head"]["ref"],
        "url": pr["html_url"],
        "updated_at": pr["updated_at"],
    }))
print(f"total_open={len(data)}", file=sys.stderr)
