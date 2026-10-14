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
- **SDK enrichment: count spawns, not queries.** `ChildProcess.spawn` blocks the main
  thread (~36 ms each in a large process), so `SCAN_CONCURRENCY` cannot parallelise it;
  the old 4-5 `sqlite3` spawns per agent cost 100 s of the 106 s serial rich scan here.
  `loadSdkAgentEnrichment` now reads a database in-process with sql.js only when it is
  under `SQLJS_PREFERRED_MAX_BYTES` (16 MB) and `-wal`/`-journal` are empty
  (`isMainFileComplete`; sql.js ignores sidecars, so it must never read past a non-empty
  one). Everything else uses one `sqlite3 -readonly` run (row format below) with the runs and
  events statements in one `BEGIN`/`COMMIT`, separated by a `.print` marker so an empty
  result set cannot shift the other (`parseSqliteCliResultSets`),
  falling back to the stepwise path on any non-snapshot error. `SqliteSnapshotRequiredError`
  always propagates, and the fallback must never mask a main-file race. Test with spawn
  counts (`sdk-enrichment-read-paths.test.ts`), not wall time: timings on a loaded
  machine are noisy.
- **Never read large text through `sqlite3 -json`.** The CLI escapes every `"`/`\` with a
  pass that is quadratic in the string length (sqlite 3.51: 200 KB of quotes = 30 s;
  1.5 MB of Cursor request context = 14 s; `-quote`/list/`hex()` = ~25 ms). Cursor values are
  JSON stored as TEXT, so this is the common case, and a single session cost up to 8.6 s.
  Use `SQLITE_CLI_ROW_FLAGS` + `parseSqliteCliRows` from `provider-core/src/sqlite-cli.ts`
  (`-quote -header`, linear, typed, Windows keeps `-json`); split multi-statement output
  with `sqliteCliResultSeparator`/`parseSqliteCliResultSets`. The bubble, request-context,
  agentKV and SDK reads use it. Also project only the fields you consume in SQL (request
  contexts: four arrays, via `json_type(...) = 'array'`). `readCursorLiveDiagnostics` still
  uses `-json` because `live-snapshot-scope.test.ts` mocks the CLI by that flag; move it
  once that test is updated with maintainer approval (`packages/cli/test/README.md`).
- **Known remaining cost: large shared `index.db`.** A 148 MB WAL-mode database holding
  266 agents still costs ~88 ms per agent, almost all in `withSqliteReadSource` staging a
  fresh snapshot per operation (SQL itself is ~12 ms; the same call is 0.1 ms once the
  snapshot is staged in the scope). Fixing it needs a fingerprint-validated, idle-expiring
  snapshot pool; do not simply wrap a whole scan in one `withSqliteSnapshotScope`, which
  would let cached scan results record a newer fingerprint than the data they hold.
- **`sourceFingerprint` intentionally changes whenever the live global DB does.** That is
  by design (late tool results), not a cache bug; do not "fix" it to stabilise output.
