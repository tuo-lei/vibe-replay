# Codex provider accounting

- Cold rollouts can be `.jsonl.zst` while SQLite retains a logical `.jsonl`
  path. Use `rollout.ts` for read-only streaming decompression and plain-first
  sibling resolution. Never materialize or modify the Codex source files.

- Discovery persists each complete rollout read in `codex-rollout-scan-v1`,
  keyed by resolved path and invalidated by dev/inode/size/mtime/ctime. Only
  content-derived `SessionInfo` is cached; git repo, `session_index` titles and
  state-DB metadata are applied live on a clone. Unreadable or racing reads are
  never cached, nothing is written inside `withReadOnlySqlite(true, …)`, and
  local plus staged SSH homes share the key with a serialized merge (same rules
  as `packages/provider-pi/AGENTS.md`). Bump the key when extraction output changes.

- Classify host-injected user records before prompt discovery or parsing.
  Heartbeats and native `Automation:`/`Automation ID:` headers are automation
  triggers, not human interventions. Preserve them as replay context, and keep
  automation-only transcripts replayable. Ambient Page metadata is not content.
- `exec-tools.ts` only reads JavaScript syntax. Never execute transcript source,
  guess calls inside loops/branches, or borrow batch output as a child's result.
  Keep the original wrapper/output; `_isToolContainer` excludes its duplicate
  count once nested calls can be reconstructed. Unsupported scripts stay opaque.
- Token attribution follows source order and recorded model changes. Use
  cumulative deltas, not repeated `last_token_usage` or billing envelopes. Reset
  baselines have unknown attribution; later monotonic deltas keep their models.
  Deltas spanning an automation interval with no bill have unknown attribution.
  Human turn metrics must not absorb an intervening automation's calls/billing.
- Add regression tests without weakening existing assertions. Sanitized fixtures
  must not contain real local prompts, paths, tokens, or credentials.
