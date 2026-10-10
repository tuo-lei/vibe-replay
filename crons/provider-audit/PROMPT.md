---
name: provider-audit
description: Weekly Mac-bound raw provider-format census plus independent discovery/parser compatibility audit; private reports and state, no product fixes or automatic publication.
schedule: "0 2 * * 2"
timezone: America/Los_Angeles
---

# Provider format and compatibility audit

Audit **the maintainer's enrolled Mac mini**, not the scheduler's current machine
by default. This repository-maintained prompt combines the former local
`weekly-upstream-schema-watch` with `provider-audit`. It is an **audit/report**
workflow, not a parser-fix, PR, deploy, or release workflow. Read `AGENTS.md`,
applicable provider `AGENTS.md`, and this directory's `README.md` before work.
The weekly Tuesday 02:00 Los Angeles schedule is a proposal, not activation.
Never enable, edit, or delete either old automation or any other scheduler.

## 1. Fail closed on target, permissions, and baseline

The operator must supply `PROVIDER_AUDIT_CONFIG`, an absolute path to a private
local configuration following `README.md`. It must enroll `target_id: mac-mini`,
`platform: darwin`, a SHA-256 binding of this Mac's IOPlatformUUID and local UID,
an external private state directory, and an explicit allowlist of local session
roots/files and optional legacy schema-state directories. Compare the hardware
binding and UID **before reading session data or creating audit state**. Missing
configuration, a different machine/account, unavailable identity, or an unsafe
state location means `blocked-target`; do not auto-enroll, weaken the binding,
substitute HOME, access SSH/staged cloud sessions, or reroute to another host.
A scheduler may invoke this prompt only on that enrolled Mac. Never put the
hardware UUID, UID, binding, private paths, or config contents in observations,
the ledger or reports; only the private enrollment config holds the binding
and approved paths, not raw hardware identity.

Use only already permitted allowlisted sources. Record `denied` and stop that
source on a permission denial; do not retry with escalation, a different API,
copied files, alternate user, decryption, or permissions changes. Do not read
credential/auth/settings files. First inspect discovery/parser code for side
reads: if an invocation would read unapproved config, profiles, credential files,
remote data, or paths outside the allowlist, mark that validation unavailable.
Use a documented narrower provider entry point or pure lines parser where safe;
state the omitted enrichment. Never patch product code to bypass that boundary.
Permission/config failures are not empty histories or evidence of schema removal.

Work in a clean isolated checkout. Fetch `origin/main` and record the full pinned
baseline SHA; use only that fetched tree for compatibility decisions, not a stale
maintainer checkout. If fetch fails, record `blocked-baseline` and leave current
baselines unchanged. Read-only raw observation is optional in that case, but it
cannot yield a compatibility pass. Install frozen-lockfile dependencies only in
the isolated checkout. Never reset/rebase/checkout the maintainer's checkout.

## 2. One private ledger and immutable history

Use `README.md`'s private state protocol: owner-only directory/files, one exclusive
lock, one append-only run ledger, immutable per-attempt provider observations,
and atomically replaced pointers. Do not use a GitHub issue as the run ledger.
The run key is `(target_id, Los Angeles Tuesday week-start date)`; retries in the
same slot keep that key and get distinct attempt IDs. Record actual check time,
source window, and baseline separately. Read the latest three relevant attempts,
unresolved finding fingerprints, per-source coverage, historical schema union,
and removal streaks before scanning. A completed slot is a duplicate; a partial
or interrupted attempt can resume unresolved sources, not silently become clean.

A lock held by another live attempt means `skipped-concurrent`; never break it.
A crash leaves a recoverable abandoned attempt. The operator must establish the
owner is gone before releasing a stale lock; never expire a live lock by age.
On shutdown release only this attempt's lock. Incomplete files must not become
current baselines. Missing/corrupt state is `blocked-state`, not permission to
reset it. A never-enrolled provider can establish a separately identified first
baseline; this is not proof of compatibility and not a noisy drift finding.

Read approved old snapshots/logs **read-only**. Do not overwrite, rename, delete,
copy raw legacy records wholesale, or change old missing counters. Import only
schema-derived fingerprints, dates and compatible counter evidence into a new
versioned epoch, recording a digest and provenance in private state. Preserve
old baselines and merge historical field unions; a short sample must not delete
old conditional fields. If source scope/fingerprint format differs, keep the
old comparison separate and establish a parallel baseline instead of pretending
history is comparable. Never import legacy `sample_files`, `source`, session IDs,
paths or free-form notes. This task does not migrate existing state destructively.

## 3. Discover storage twice; make coverage explicit

Enumerate **all providers registered in `packages/providers-default`**, including
Claude Code/Desktop/Cowork separately. Read each provider's source-path logic
and nested instructions. Honor approved local env overrides only if their
resolved paths are allowlisted; do not silently use an override on another host.
Treat Cursor JSONL/SQLite/SDK, Hermes profiles, OpenCode legacy/v2, Pi/OMP,
Desktop metadata/backing transcripts, and Grok replicas as separate source
strata where they exist. Never decrypt encrypted conversation blobs or generic
application stores. Do not use bundled samples as evidence of local availability.

**Track A — independent raw discovery:** enumerate approved storage using only
file metadata and documented layouts, **before** invoking discovery or parsing.
Inventory recent raw session containers even when the current provider returns
no sessions or would silently skip unknown records. Do not derive the raw census
from parser output, discovery previews, or only parser-accepted records. Include
stable provider-native child transcripts when allowed; do not confuse discovery's
intentional top-level subagent hiding with raw schema coverage.

**Track B — provider discovery:** invoke the current provider's own discovery,
with `{readOnly: true}` and `withReadOnlySqlite(true, ...)` where supported. Prefer
bounded, documented source-root entry points; disable optional git/config
lookups where those entry points support it. Do not reimplement the application's
session selection logic. If discovery cannot be bounded without reading the full
history or unapproved inputs, mark it `deferred-budget` or `denied`; retain raw
coverage and report that discovery compatibility was not verified. Compare raw
containers with discoverable/replayable sessions, explaining legitimate
metadata-only, child-session and duplicate cases rather than asserting all raw
files should appear in the picker.

Window: the preceding 14 days, using file metadata and provider-native activity
metadata where safe. Re-check files older by filesystem mtime when a provider's
storage layout makes mtime unreliable; otherwise mark that stratum partial.
Default run budget: 30 minutes, 200 session containers and 256 MiB total reads;
limit a container to 16 MiB and a JSON record to 1 MiB. Apply these caps to raw,
discovery, parser and any transitive reads together. Record exact included,
skipped-active, denied, missing, oversized, deferred and budget-truncated counts
per stratum. No budget truncation may be called full coverage; save a private
continuation watermark and fairly rotate strata/recent stable sources next time.
For full weekly census, process every eligible stable container within the
window if it fits the budget. Never launch a costly all-history scan to fill gaps.

Skip any file changed in the last 60 seconds, including this running task's
session. Before and after each read/parse compare realpath identity, inode,
size, mtime and ctime; if any change, discard that observation and mark active.
Reuse each bounded raw read in memory for exported pure-parser entry points
when supported: one corpus selection and raw read, two independent judgments.
Official discovery may need its own bounded read; include that cost in the same
budget, not a second full scan. Do not rewrite its API to force one physical pass.
Treat an unfinished final JSONL record as inconclusive until the file is stable.
For SQLite use existing zero-write snapshot guards: a nonempty WAL, pending
rollback journal, changed snapshot, or unavailable sidecar verification means
`deferred-active`, not stale main-file data. Never checkpoint, recover, write
SHM/WAL, kill the source app or copy just a live DB to force a pass. Guard-owned
private temporary SQLite snapshots are allowed only after stability/WAL checks,
with owner-only access and cleanup on exit; never place them in audit history. Re-check
authorized transitive files too; inability to bound/validate them is partial.

## 4. Independent raw census, then compatibility validation

Stream raw JSONL/JSON/replica envelopes; for stable permitted SQLite, inspect
schema tables/columns plus bounded session/message payload rows read-only. Do
not census unrelated tables or auth storage. Across **all raw records** collect:
record/item/nested content-block types, roles, provenance classifications, tool
names and decoded argument **key/type signatures only**, shallow and relevant
nested field-name/type sets (including message parts and usage fields), and
counts/frequencies. Unknown types, fields and type changes must survive even
when parser/discovery drops them. Do not let noise filters erase raw observations.
Random ID/UUID/timestamp **values** are not drift. Arbitrary object keys, type
strings, tool names and provenance may contain sensitive literals: fingerprint
them with the private audit key, not plain-text persistence or output. Never
record prompts, text, thinking, summaries, arguments/results, images or values.

Compare with historical raw fingerprints and the pinned parser/type/tool
registries. Inspect 2–3 bounded candidate occurrences in memory, no raw excerpts
in logs. A stable new field/type can be considered immediately; distinguish:

- `confirmed-impact`: reproduced exception, dropped intended content, wrong
  role/order/usage, or unsupported user-facing feature with concrete evidence.
- `compatible-metadata`: current behavior is compatible or deliberately ignores
  runtime metadata; retain the fingerprint and reasoning code privately.
- `unverified`: plausible impact but blocked/missing validation; never label it
  confirmed, clean, or passed. Include a concrete private follow-up step.

For each observed stratum, run its **actual current parser** on bounded stable
samples selected by discovery, and a bounded raw candidate omitted by discovery
when relevant. Compare raw evidence to intended parsed roles, ordering, tool
mapping/results, prompts vs runtime injections, compactions and token/cost
provenance. Preserve provider-specific qualifications: e.g. cumulative vs bill
usage, SDK transcript vs DB enrichment, native vs inferred clocks, and providers
that do not persist tokens. Zero warnings alone is not proof of completeness.
Use plain counts/booleans in the report; discard parsed content and raw errors.
If a safe narrow entry point omits side reads, record both tested core parsing
and unverified full enrichment/discovery as separate facts.

Run affected provider fixture tests sequentially for new candidate impact, plus
an entirely invented minimal fixture/harness if useful. Do not copy/redact real
content into a committed fixture: construct new synthetic content and IDs. Do
not change parsers, product code, tests, CI, versions, or runtime behavior to fix
a finding. No PR from this scheduled audit. If a check is unavailable/fails,
record it honestly; never substitute green tests for unavailable real-source
validation. Do not require full product verification on every unchanged weekly
fingerprint; the implementation PR for this workflow still requires `pnpm verify`.

## 5. Missing data, deduplication and reporting

A provider never used here or with no recent permitted sample is `not-observed`,
not a failed product. Skip gracefully and continue others. Previously established
but now missing/unreadable strata remain in history and are `missing-source` or
`denied`; no absence/removal inference. The overall run is partial when a required
or established stratum lacks either raw or compatibility coverage. Display the
provider matrix even when storage detection returns false, since probes may
suppress permission errors. Do not claim coverage for unavailable machines.

A field/type can be called a removal candidate only after **three consecutive
weekly slots with successful comparable raw coverage** in that stratum all miss
it, followed by concrete compatibility evidence. Offline, denied, active,
truncated, missing-provider and interrupted slots do not advance that streak;
a gap in comparable weekly observations breaks consecutiveness. A retry in the
same slot advances at most once. Keep historical union and last-seen separately
from observed-current; never delete a historical shape when it is absent.

Use a stable finding identity from provider+stratum and schema change, using
HMAC for sensitive/source-derived identifiers. Keep outcome, full baseline SHA
and policy version as evidence, not a reason to renotify the same finding. Cache
validation separately by source evidence and the relevant discovery/parser
dependency-code and policy fingerprints. Skip expensive revalidation and repeated
reports for unchanged benign/rejected evidence; retry unresolved validation only
when its blocker, source evidence or relevant code/policy changed. An unrelated
main commit or a new week alone is not new evidence. Label cached verdicts with
their original tested SHA/time and the unchanged relevant-code proof; do not
claim a fresh test or apply the cached verdict to a different schema/scope.
Append a quiet ledger outcome nevertheless. Before any **separately authorized**
publication, check open schema-watch issues by provider/field/label and the past
four weeks; update an equivalent existing issue only with new evidence, maximum
one issue per provider, never open issues for compatible-metadata. Unverified
publication requires explicit potential impact and reproduction steps. GitHub
unavailable means defer that optional dedup/publication step, not invent status.

**Default is private reporting only.** No GitHub issues/comments, messages to
others, uploads, replay export/sharing, or real-session findings in a template PR.
Publication needs explicit separate authorization for the concrete evidence.
Even then use coarse provider/error categories plus entirely synthetic fixture,
expected/actual behavior and baseline SHA; no private schema literals, source
paths, IDs, raw content, tool payloads, credentials or hardware identity. A failed
privacy review blocks publication, never causes a fallback to raw evidence.

Always record one final attempt outcome and per-stratum coverage privately:
`completed`, `partial`, `blocked`, `duplicate`, or `skipped-concurrent`. A
completed run means all enrolled required/established strata were covered in
both tracks; it does not mean no drift or all possible providers on all machines
were tested. Return a concise private provider matrix, baseline, counts, new
confirmed/unverified findings, skipped sources and next steps. Suppress repeated
unchanged notifications; never say simply "clean" on partial coverage. An offline
Mac produces no run: on the next local start, record the missed slot(s), do at
most one bounded catch-up for the current window, and do not infer clean history
or replay every missed week. Retries reuse the slot/ledger under the same lock;
do not create heartbeat loops, alternate crons, or another machine fallback.
