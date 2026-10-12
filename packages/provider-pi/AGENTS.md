# AGENTS.md — provider-pi

Pi-specific gotchas that do not fit in the root `AGENTS.md` size budget.

## Discovery performance

Discovery runs on every `vibe-replay sessions` call. A real machine holds hundreds of
append-only JSONL transcripts (about 250 files and 900 MB here), and streaming all of them
line by line cost about 3s per call.

- **Per-file scan cache.** `discoverPiSessions` persists each transcript's content-derived
  scan (`PiFileScan`: header, counts, first prompts, title, model, resolved compaction
  count) in `pi-session-scan-v1`, keyed by absolute path and invalidated by file size and
  mtime. A warm run reads no transcript (about 20ms). The file is stat'ed *before* it is
  read, so an append racing the scan can only cause a re-scan, never a stale hit.
- **Options are applied after the cache.** `resolveGitRepo` and `includeUnreplayable` are
  applied in `buildPiSessionInfo` on top of the cached scan, and `cwd`/git-repo resolution
  stays live. Do not move option-dependent data into `PiFileScan`.
- **Failed reads are never cached.** A transcript that errors while streaming may be
  partial, so it is rescanned next time.
- **One shared cache key.** Entries for other roots are kept while their file still exists
  (local, OMP and staged SSH roots share it); entries under the scanned root that vanished
  are pruned. Roots are discovered concurrently, so the read-merge-write is serialized
  in-process and merges against a fresh read of the cache, never the pre-scan snapshot
  (otherwise the last writer drops another root's entries). The cache is only rewritten
  when something was rescanned or pruned, and never
  inside `withReadOnlySqlite(true, …)` (`isSqliteReadOnlyScope`), which is the shared
  zero-write contract despite its name.
- Cold scans run with bounded concurrency (8) and keep directory order, so output order and
  tie-breaking match a serial scan.
