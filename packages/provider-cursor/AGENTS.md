# AGENTS.md — provider-cursor

Cursor-specific gotchas that do not fit in the root `AGENTS.md` size budget.

## Discovery performance

Discovery runs on every `vibe-replay sessions` call, so its cost is user-visible. A real
machine can hold a ~25 GB `state.vscdb` (mostly `bubbleId:*` rows) and hundreds of SDK
`index.db` files.

- **Probe, don't count.** Discovery only needs to know whether a composer has *any*
  replayable bubble. `hasReplayableGlobalStateBubbleSql` is an `EXISTS` probe, and the
  WASM fallback (`hasReplayableGlobalStateComposer`) loads bubbles in small chunks and
  stops at the first hit. Never reintroduce `COUNT(*)` over bubbles: it forces SQLite to
  parse every bubble of every composer (~19s here versus ~1s with `EXISTS`).
- **Composer metadata is cheap, bubbles are not.** Scanning all `composerData:*` rows is
  about 2s for 185 MB. Anything that joins or parses `bubbleId:*` per composer must
  short-circuit.
- **SDK agent index is persisted per database.** `getSdkAgentIndexOnce` caches each
  `index.db`'s agent rows in `cursor-sdk-agent-index-v1`, keyed by path and invalidated by
  the file's size/mtime plus its `-wal` size/mtime. Finished automation runs never change,
  so a warm scan opens none of them. Misses are read with bounded concurrency and merged in
  path order so a duplicate agent id resolves as a serial scan would. Only successfully
  read databases get an entry, and nothing is written inside `withReadOnlySqlite(true, …)`
  (`isSqliteReadOnlyScope`).
- **`sourceFingerprint` intentionally changes whenever the live global DB does.** That is
  by design (late tool results), not a cache bug; do not "fix" it to stabilise output.
