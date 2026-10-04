# Codex provider accounting

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
  Human turn metrics must not absorb an intervening automation's calls/billing.
- Add regression tests without weakening existing assertions. Sanitized fixtures
  must not contain real local prompts, paths, tokens, or credentials.
