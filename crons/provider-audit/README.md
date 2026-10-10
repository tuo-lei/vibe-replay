# Provider audit: one Mac, two independent checks

`PROMPT.md` combines local upstream-schema-watch's independent raw drift census
and compatibility checks with provider-audit's provider-owned discovery,
record/item/tool/provenance inventory, and judgment. It remains **audit/report
only**: findings do not authorize parser fixes, PRs, deploys or publication.

The proposed cadence is **Tuesday 02:00 America/Los_Angeles**. It retains the
former Mac schema-watch slot, away from Monday dependency/Eng maintenance and
Wednesday docs maintenance. The prompt's cron expression is data, not a
scheduler change. An operator must explicitly select the maintainer's Mac mini
as the execution host; a generic cloud runner is ineligible. Both former jobs
remain paused unless separately changed by their owner. Do not activate a
second audit in parallel. Existing externally installed copies (including a
Muse provider-audit) are not updated by editing this repository.

## Enrollment: fail closed before reading histories

The scheduler passes only `PROVIDER_AUDIT_CONFIG`, pointing to a private,
owner-only JSON file outside every Git worktree. The operator enrolls it on the
intended Mac; the scheduled agent must never create/rebind it automatically.
No secrets, machine identifiers, or actual local paths belong in this repo.

The configuration contract (placeholders, **not a usable configuration**) is:

```json
{
  "version": 1,
  "target_id": "mac-mini",
  "platform": "darwin",
  "machine_account_sha256": "<private enrollment binding>",
  "state_dir": "<absolute private path outside all Git worktrees>",
  "sources": [
    {
      "provider": "<registered provider>",
      "stratum": "<documented source kind>",
      "roots": ["<absolute permitted local session-only root or file>"],
      "required": true
    }
  ],
  "legacy_schema_roots": ["<optional approved legacy schema-only directory>"]
}
```

On macOS, obtain `IOPlatformUUID` using `/usr/sbin/ioreg -rd1 -c
IOPlatformExpertDevice`, extract only that property in memory, and compute
SHA-256 of the UTF-8 string `provider-audit-v1\0<UUID>\0<process.getuid()>`.
Reject anything other than one nonempty UUID and the expected current UID. Do
not print, log or persist the UUID/UID; only the binding is stored in the private
config. Before every attempt recompute and compare it, check Darwin/target_id,
and verify config ownership and mode (0600; owner is current UID). A different
Mac, account, missing identity, missing config, or unreadable config is blocked.
Do not rely on hostname alone or copy a configuration to auto-enroll a new host.
A machine replacement or permission expansion requires explicit reenrollment.

Resolve allowlisted paths and check symlink targets before opening them;
symlinks must not expand authorization. A source root must contain only the
approved session storage layout, not an entire home/application/config tree.
Exclude auth, secrets, provider settings, encrypted generic conversation stores,
SSH caches and remote targets. A code path that reads those inputs is not safe
just because its method is named `discover` or `parse`. Inspect transitive reads
and use documented narrower entry points when possible; otherwise report the
missing validation. Approved changes to roots do not reset historical coverage.

The state directory must be an absolute local directory owned by the current
UID, mode 0700, outside Git worktrees, session source roots, temporary/disposable
checkout roots, and cloud-sync folders. Reject symlinked state paths or unsafe
ancestor ownership. Files are 0600. Never default to `crons/.../snapshots`, an
ignored repo directory, or a remote ledger on missing configuration. There is
no need for API keys, auth inspection or a network-mounted session replica.

## One persistent state protocol

All files below are **private and untracked**, under configured `state_dir`:

```text
key.bin                         32 random bytes; HMAC key, created once
lock/owner.json                 exclusive atomic mkdir lock + attempt owner
ledger.jsonl                    one append-only ledger for this target/task
attempts/<slot>/<attempt>/       immutable observations and checkpoint files
providers/<provider>/<stratum>/  versioned history/current pointers
```

The operator creates the new state root/key once after enrollment. If a state
root is missing later, the run blocks instead of recreating it and forgetting
history. An initial empty root is explicitly marked `uninitialized`; the first
successful run establishes baselines, not a claim that all providers are clean.
Never rotate/regenerate a missing key automatically: changing it makes old
fingerprints incomparable. Keep versioned epochs across deliberate key/policy
changes and retain the previous epoch read-only.

Use HMAC-SHA256 with that private key for source identity and arbitrary
source-derived field paths/type strings/tool/provenance names. Plain SHA of
low-entropy/private names is susceptible to guessing. Do not include content/payload
values or raw snippets in fingerprint inputs/persistent records; schema selector
strings are encoded with HMAC as described above, never stored as plain literals. File identity
is derived from realpath in memory and persisted only as a keyed fingerprint;
plain paths, session IDs, titles, user/agent names, model strings, timestamps
from messages and raw warning/error text never enter audit state. Repository
baseline SHA, audit times, public provider/stratum labels, coarse reason codes,
booleans, counts, and keyed schema signatures are allowed. Source content stays
in memory or guard-owned private temporary SQLite snapshots only. Such snapshots
require stability/WAL guards, owner-only access and cleanup on exit; they never
become persistent audit state. Known structural labels may be rendered only after verifying
against public source code and a privacy review; arbitrary dictionary keys and
dynamic MCP/tool names are not automatically safe because they are "names".

Observation records carry `schema_version`, `policy_version`, `slot`,
`attempt_id`, `baseline_sha`, `provider`, `stratum`, `window`, coverage counts,
raw signature counts, validation status, historical union references,
last-seen slot, missing streak, and outcome/finding fingerprints. No free-form
source-derived text. Store private next steps using coarse reason codes and
repo-relative code locations, not transcript excerpts. Local wall-clock audit
times describe audit execution, not private conversation timestamps.

Acquire the lock with atomic `mkdir` before accessing state. Under the lock:
write new observations to same-directory temporary files with exclusive create,
fsync them, rename to immutable attempt files, append/fsync the ledger, and then
atomically update small current pointers. Publish a pointer only if its immutable
file and corresponding ledger event exist. On crash, reconcile pointers from
the ledger and immutable observations; discard incomplete temporary files only
after proving they belong to the abandoned attempt. Never replace ledger/history.
Partial observations have their own coverage; they do not replace comparable
full baselines. Only this attempt releases its own lock. No age-based automatic
lock breaking; a live job can exceed the normal budget during shutdown.

A slot is the Los Angeles calendar Tuesday beginning the scheduling week. A
retry gets a new attempt ID, reuses the same slot and source checkpoint, and
advances missing streaks at most once per source/slot. `completed` is terminal
for that slot; `partial`/`blocked`/interrupted can resume. If partial attempts
cover different subsets, aggregate only stable observations with the **same
pinned baseline, policy, and 14-day window**; otherwise start a distinct attempt
and do not stitch them into a fictitious complete census. A completed slot may
have confirmed findings; completion measures enrolled coverage, not absence of
bugs. New providers/strata remain explicit `not-observed` until established.

## Preserve legacy state without rewriting it

The former schema-watch may retain field unions/missing counters in its private
plan schema-snapshots and logs; former provider-audit may have separate snapshots
on another host. Enroll only existing **local, permitted schema-only** legacy
roots. Preserve those files in place; this workflow must not create snapshots
in the tracked repo or import other hosts' data as Mac evidence.

Read legacy schema/date/counter fields in memory, encode comparable schema
labels with the new HMAC key, and record the legacy file digest, date and coarse
format version in a new observation epoch. Drop sample paths/IDs, `source`,
free-form notes and any source content; never copy the whole JSON or log. Validate
that prior consecutive-week evidence is actually comparable before retaining a
missing streak. If uncertain, retain history but record streak evidence as
inconclusive. Old first-seen/last-seen must not be replaced by import time.
A different census scope or shape policy requires a parallel baseline, not a
fake drift explosion or an erased old baseline. Existing history is never
changed to fit the new format. Initial imported schema is not proof that today's
source is accessible or parser-compatible.

## Running both tracks safely

Use source code as the documented layout authority. Track A metadata enumeration
is independent of discovery's type/replayability filters. Track B uses the
provider's own discovery/parser entry points. Reuse bounded in-memory records with
exported pure parsers where possible; official discovery may reread the selected
scope and must count those reads against the same budget. Sharing a corpus does
not mean using parser-filtered data as the raw census or rewriting discovery.
`Provider.detect()` is only a storage hint: it can suppress permission errors; a false result does not prove
absence. When exported API lacks bounds, use its documented root/file entry
point on an approved narrow scope. Do not call full discovery over history and
then merely trim the returned array. If the only supported path exceeds budget
or reads forbidden inputs, report partial rather than rewriting discovery.

Stable JSONL is streamed; raw signatures include unknown record types and field
value **types**, including nested parts/usage and decoded argument key signatures.
All payload **values** are discarded. SQLite needs a current zero-write snapshot
and bounded session-specific rows; active WAL/journal is deferred, not recovered.
Provider-native subagents/metadata enrichments remain separate strata. Transitive
reads share the same stability checks, allowlist and budget. Duplicate/alias
sources share raw file identity but do not hide differing storage formats.

Default limits are 14 days, 30 minutes, 200 containers, 256 MiB reads, 16 MiB per
container and 1 MiB per record. Record incomplete coverage explicitly and rotate
continuations fairly; never infer a disappeared field from truncation. Choose
2–3 stable occurrences of a new candidate for compatibility checks, avoiding
active files and the audit's own transcript. An exported pure lines parser can
validate core parsing without reading forbidden model/auth config, but does not
prove full discovery or optional enrichment. State that distinction in results.
For unchanged source/schema/parser fingerprints, avoid repeated expensive tests;
new parser baseline, new source evidence or changed blockers justify retry.

Missing providers do not cause speculative issues. Three consecutive comparable
successful weekly raw observations are required for field removal, with impact
validation afterwards; offline or partial weeks break the streak. Maintain
last-seen and historical union independently. A Mac offline at schedule time
has no successful attempt; next local invocation records missed slots and does
one bounded catch-up, not an all-history replay. Never fall back to another host.

## Reports and publication boundary

One ledger serves both tracks. Its coverage matrix separates raw-census status,
provider discovery status, core parser status, enrichment status, budgets and
missing sources. Partial runs can still supply useful new confirmed findings,
but cannot end with an unqualified "clean". Notify only newly actionable
fingerprints or changed blockers; retain quiet weekly outcomes and unchanged
benign/rejected signatures locally. There is no automatic public run ledger.

Public publication is **off by default**, even if an old routine allowed issues.
A separately approved finding may use provider name, coarse impact, public
baseline SHA and a wholly invented reproduction fixture. No real-session shapes
with sensitive literals, paths, credentials, prompts or tool payloads. Recheck
existing schema-watch issues and the previous four weeks before that publication;
update only with new evidence, maximum one issue per provider. Benign metadata
never gets an issue; unverified evidence needs concrete potential impact and
follow-up, and must remain labeled unverified. No issue/PR is created by this
audit itself. The audit does not request reviews or merge anything.

## Setup acceptance (bounded, private)

Before the operator enables a schedule, validate on the enrolled Mac:

1. Verify the target gate accepts this Mac and rejects missing config, a foreign
   binding, unsafe state path, or another account **before any session read**.
2. Probe all registered provider storage roots without reading auth files.
   Independently distinguish missing/denied; do not infer availability from
   bundled samples. A setup smoke test is deliberately sampled, not a weekly
   full census.
3. Read at most one stable, permitted, small recent container per available
   stratum. Stream raw signatures independently, then use narrow official
   discovery/core parser entry points where safe. Print only coarse counts,
   statuses and warning counts; never prompts, titles, IDs, paths or errors.
4. With entirely synthetic data, prove an unknown record/type survives the raw
   census when the current parser skips it, an unchanged fingerprint is quiet,
   retries cannot double-advance removal streaks, partial/offline slots cannot
   advance them, concurrent runs cannot overwrite state, and sensitive literals
   do not appear in persistent/report output. Leave existing snapshots unchanged.
5. Record which real source/core/discovery/enrichment strata were actually tested
   and the missing validation. Enabling remains an operator action; do not
   convert a partial smoke test into an audit-wide compatibility pass.

Template/docs changes follow normal repo review: `pnpm lint`, `pnpm lint:check`,
sequential `pnpm verify`, then a PR. No actual machine enrollment, private state,
real-session findings or data belongs in that PR. Merge requires its own approval.
