# Session discovery and export performance

Measured on the authorized Mac mini using Node 22.22.3 and pnpm 10.24.0.
Baseline `bc450d0f5` already includes #703–710 provider concurrency, startup
progress and discovery/cache improvements.

## Corpus and boundaries

All ten local providers were attempted; no SSH sources were contacted. Original
JSONL/DB/WAL/SHM files were not modified. Private local copies and exports were
never uploaded or committed. Only aggregate measurements and synthetic tests
are published.

| Provider | Entries | Reported source bytes | Median bytes | P90 bytes | Maximum bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Code | 459 | 854,953,274 | 454,624 | 5,822,308 | 59,035,145 |
| Claude Desktop | 64 | 24,806,430 | 254,312 | 577,632 | 6,093,726 |
| Claude Cowork | 120 | 143,653,966 | 628,202 | 3,243,896 | 17,251,474 |
| Codex | 71 | 698,113,689 | 1,717,849 | 21,898,903 | 146,481,945 |
| Pi | 20 | 7,542,003 | 164,508 | 1,131,619 | 3,202,903 |

Provider entries overlap. Priority deduplication and resume merging yield 666
logical sessions from successful providers, reporting about 1.70 GB. Codex
includes 17 unavailable/no-prompt entries. Hermes additionally returns three
partial entries with a checkpoint-required failure; OpenCode reports the same
active-WAL protection without entries. The full degraded catalog has 669 entries.
Cursor, Grok Bot and Muse have no local entries. The exploratory harness counted
only successful provider results; the committed benchmark also retains entries
carried by checkpoint errors.

## Measurements

Application file caches were disabled for cold measurements. **The OS cache was
not flushed.** One live Codex transcript grew during measurement; 665 of 666
successful live catalog objects stayed exactly equal. Fixed-input comparisons
below control this independently.

| Measurement | Before | After | Scope |
| --- | ---: | ---: | --- |
| First successful usable provider | 270–283 ms | 404–422 ms | No improvement claimed |
| Complete local discovery | 8.88–9.09 s | 7.62–7.68 s | Live corpus, application cache disabled |
| Complete rich background scan | 6.67 s | 6.65–6.99 s | No material improvement |
| Typical parse → transform → HTML export | 15.6–17.1 ms | 13.2–14.0 ms | 490,282 bytes, 98 scenes |
| Large parse → transform → HTML export | 9.87–10.03 s | 1.48–1.54 s | 146,481,945 bytes, 1,057 scenes |
| Five HTML generations of an existing large replay | 403–433 ms | 399–437 ms | File generation only; no material improvement |

A private fixed snapshot of the complete Codex/Claude JSONL trees and Codex
metadata was measured in three alternating before/after runs. Rollout references
were rewritten only in the private database copy. Both versions produced
**exactly equal complete discovery objects**, including ordering and metadata:

| Run | Discovery before | Discovery after | Large transform before | Large transform after |
| --- | ---: | ---: | ---: | ---: |
| 1 | 8,018.6 ms | 6,462.3 ms | 9,732.1 ms | 1,041.6 ms |
| 2 | 7,928.1 ms | 6,510.1 ms | 9,728.6 ms | 1,093.1 ms |
| 3 | 7,900.8 ms | 6,455.6 ms | 9,566.1 ms | 1,041.4 ms |

Median fixed-corpus discovery improved 18.5%; median large transform improved
89.3%. Complete replay objects were equal in every fixed-input comparison.
Typical and large real-session scene hashes also matched across live runs.

A five-session batch used source-size quantiles 25/50/75/90/100% (45, 98, 134,
291 and 1,057 scenes). Three alternating runs transformed the same captured
complete parse results, then performed real HTML export with the unchanged
validation/redaction report. Transform+export medians were 9,907.1 ms before and
1,318.6 ms after. Initial parsing took 317.1 ms, measured separately. All five
complete objects were equal every run. A subsequent fresh parse+transform+export
batch took 1,665.9 ms.

Warm application-cache restore was measured separately with a dedicated fresh
envelope containing the same 666 successful session objects, the real cache
reader and resume merger: 7.92, 2.77 and 2.69 ms. Only that dedicated cache was
removed afterwards. This measures catalog recovery, excluding browser startup
and background refresh; no warm-cache speedup is claimed.

## Evidence-backed changes

The large transform CPU profile was dominated by email-redaction regex retries
at every suffix of long alphanumeric/base64-like runs. Restricting attempts to
the maximal local-part run retains the same leftmost matches and redacted output.
No redaction or validation was removed.

Codex state lookup and directory traversal read overlapping rollouts twice.
Successful complete reads now reuse an operation-local result only if device,
inode, size, nanosecond mtime and ctime stayed unchanged before/after reading and
still match at reuse. Unreadable reads retry; source changes invalidate reuse;
every later discovery reads current content again. Claude Code streams up to four
project directories concurrently, retaining sequential traversal/tie order,
per-project repository lookup and complete per-file scanning.

## Reproduce on an authorized local corpus

```bash
pnpm install --frozen-lockfile
pnpm build
node --import tsx packages/cli/scripts/benchmark-performance.ts --read-local-sessions --scan --batch
```

Run repeatedly on both commits without concurrent full test/build jobs. The
command emits aggregate JSONL, disables application caches, retains checkpoint
error entries, uses existing SQLite read-only guards, and deletes only its own
temporary exports. It never connects to SSH targets. Report live-file growth or
control it with private copies for strict same-corpus comparisons. `--scan` and
`--batch` are opt-in. Browser rendering is validated separately from these
backend phase timings; the first-provider figure is not browser time-to-render.

## Validation

`pnpm verify` passed, including strict lint/types, provider/CLI/viewer tests,
Cloudflare tests and a full build. Local `pnpm test:e2e` passed 42 files / 126
tests; 2 files / 51 tests were conditionally skipped by the existing suite.
Generated HTML tests cover 30- and 500-scene sessions and live/readonly flows.

The actual private 98/1,057-scene exports were additionally opened in headless
Chromium with all HTTP(S) requests blocked. Landing controls became usable in
104/180 ms before and 93/175 ms after; all scene data loaded, there were no page
errors or external requests, and playback opened successfully. This is one
browser observation per artifact, not a rendering-speed improvement claim.
