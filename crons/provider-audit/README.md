# provider-audit

Maintainer tooling for detecting **format drift** in AI provider session transcripts: new record/item types (new provider features), changed field shapes (breaking changes), new tools.

## How it works

- `PROMPT.md` is the audit prompt. It is written for an *agent*, not a script: the census of types is mechanical, but telling a new feature from internal runtime noise from a breaking change requires reading samples with judgment.
- The prompt is installed as a weekly cron (Muse). It can also be run by hand, or by any other agent against its own machine's sessions — each agent audits whatever provider sessions exist locally ("muse checks muse, grok checks grok").
- `snapshots/<provider>.json` holds the last census per provider (type names + field shapes only, no content). The audit diffs against it; the first run creates the baseline. Benign internal types are marked so future runs stay silent.

## Workflow

1. Cron (or human) runs `PROMPT.md`.
2. If drift is found, the agent reports to the maintainer with evidence + a suggested parser change.
3. Maintainer updates the parser and the snapshot in the same PR (add to the provider checklist in CONTRIBUTING.md).

## Privacy

Snapshots and reports contain type names and field shapes only — never raw prompts, tool arguments, or tool outputs.
