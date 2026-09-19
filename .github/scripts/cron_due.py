#!/usr/bin/env python3
"""Select crons/* tasks that are due to run.

Reads frontmatter from crons/*/PROMPT.md, keeps tasks with
`runner: github-actions` whose `schedule` matches within the lookback window
(evaluated in the task's `timezone`), and prints a JSON array of
{"name", "prompt", "timeout_minutes"}.

With --task, the due check is bypassed (manual run of a single task).
"""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo


def parse_frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    data: dict = {}
    key = None
    for line in m.group(1).splitlines():
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*:\s*(\||>|-?>)\s*$", line):
            key = line.split(":")[0].strip()
            data[key] = []
        elif key and (line.startswith("  ") or line.startswith("\t")):
            data[key].append(line.strip())
        elif ":" in line:
            key = None
            k, v = line.split(":", 1)
            data[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in list(data.items()):
        if isinstance(v, list):
            data[k] = " ".join(v)
    return data


def field_match(field: str, value: int, lo: int, hi: int) -> bool:
    if field == "*":
        return True

    def expand(part: str) -> set:
        step = 1
        if "/" in part:
            part, step_s = part.split("/", 1)
            step = int(step_s)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a_s, b_s = part.split("-", 1)
            a, b = int(a_s), int(b_s)
        else:
            a = b = int(part)
        return set(range(a, b + 1, step))

    vals: set = set()
    for part in field.split(","):
        vals |= expand(part)
    if hi == 6 and 7 in vals:  # Sunday may be 0 or 7
        vals = {0 if v == 7 else v for v in vals}
    return value in vals


def due(schedule: str, tzname: str, now_utc: datetime.datetime, window_min: int) -> bool:
    fields = schedule.split()
    if len(fields) != 5:
        raise ValueError(f"schedule must have 5 fields: {schedule!r}")
    f_min, f_hr, f_dom, f_mon, f_dow = fields
    dom_r, dow_r = f_dom != "*", f_dow != "*"
    tz = ZoneInfo(tzname)
    t = (now_utc - datetime.timedelta(minutes=window_min)).replace(second=0, microsecond=0)
    end = now_utc.replace(second=0, microsecond=0)
    while t <= end:
        loc = t.astimezone(tz)
        dow = (loc.weekday() + 1) % 7  # cron: Sunday = 0
        if dom_r and dow_r:  # standard cron: restricted dom/dow combine with OR
            day_ok = field_match(f_dom, loc.day, 1, 31) or field_match(f_dow, dow, 0, 6)
        else:
            day_ok = field_match(f_dom, loc.day, 1, 31) and field_match(f_dow, dow, 0, 6)
        if (
            field_match(f_min, loc.minute, 0, 59)
            and field_match(f_hr, loc.hour, 0, 23)
            and field_match(f_mon, loc.month, 1, 12)
            and day_ok
        ):
            return True
        t += datetime.timedelta(minutes=1)
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--window-minutes", type=int, default=70)
    ap.add_argument("--task", default="")
    ap.add_argument("--root", default="crons")
    args = ap.parse_args()

    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for prompt in sorted(Path(args.root).glob("*/PROMPT.md")):
        fm = parse_frontmatter(prompt)
        if fm.get("runner") != "github-actions":
            continue
        name = fm.get("name") or prompt.parent.name
        if fm.get("name") and fm["name"] != prompt.parent.name:
            print(f"warning: {prompt}: frontmatter name {fm['name']!r} != directory name",
                  file=sys.stderr)
        if args.task and name != args.task:
            continue
        if not args.task and not due(
            fm["schedule"], fm.get("timezone", "UTC"), now, args.window_minutes
        ):
            continue
        try:
            timeout = int(fm.get("timeout_minutes", "30"))
        except ValueError:
            timeout = 30
        out.append({"name": name, "prompt": str(prompt), "timeout_minutes": timeout})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
