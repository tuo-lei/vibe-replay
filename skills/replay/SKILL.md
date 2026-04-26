---
name: replay
description: Generate a shareable replay summary of an AI coding session and help paste it into a PR. Walks the user through reviewing redactions, optionally translating prompts, and optionally softening tone before sharing. Use when the user asks for a "replay", wants to share a session, or wants to attach session context to a PR.
allowed-tools: Bash(npx *) Bash(grep *) Bash(ls *) Bash(cat *) Bash(cp *) Bash(gh *)
argument-hint: [session-path]
---

# Session Replay → PR

This skill turns the current (or a specified) AI coding session into a polished markdown summary that is safe to paste into a PR. It uses [vibe-replay](https://github.com/tuo-lei/vibe-replay) to produce the raw artifacts, then walks the user through three opt-in cleanup steps before sharing.

## What this skill is for

Plain text summaries of an AI session — stats, tool breakdown, per-prompt details — are hard for an agent to write from scratch. This skill delegates that to `vibe-replay`, then uses agent reasoning to handle the things a CLI cannot do well:

- **Reviewing flagged credentials** — deciding whether a regex hit is a real secret or a false positive
- **Translating** session prompts that aren't in the audience's language
- **Softening tone** in prompts written when the user was frustrated

Each step is **opt-in** — ask the user before doing it. Never silently rewrite their content.

## Step 1 — Generate the artifacts

Find the session file (use `${CLAUDE_SESSION_ID}` if running inside a live session, otherwise ask the user for a path):

```bash
grep -l '"sessionId":"${CLAUDE_SESSION_ID}"' ~/.claude/projects/*/*.jsonl 2>/dev/null
```

If multiple files match (normal after `/resume`), pick the oldest — `vibe-replay` auto-discovers related files.

Then run:

```bash
npx vibe-replay --session <PATH> --github
```

This writes to `~/.vibe-replay/<slug>/`:

- `github-summary.md` — the markdown summary (this is what gets pasted into the PR)
- `redactions.json` — credential audit report (read this in step 2)
- `session-preview.gif` / `.svg` — preview animations (skip unless the user explicitly asks)

## Step 2 — Review credential redactions

Read `redactions.json`. It has two fields:

- `alreadyRedactedCount` — how many secrets `vibe-replay` already replaced with `[REDACTED]` automatically. Just report this number to the user.
- `leftoverFindings` — regex hits in the final markdown that `vibe-replay` was not confident enough to auto-redact.

**If `leftoverFindings` is empty**, say so and move on.

**If `leftoverFindings` is non-empty**, present the findings to the user with `AskUserQuestion`. For each one:

- Show: rule (e.g. "GitHub Token"), context snippet (one line of surrounding text), and your judgment of whether it looks real
- Note that some matches are false positives — commit hashes, UUIDs, version strings, package names can look like tokens. Use the surrounding context to judge.
- Offer choices: "Redact all", "Review one-by-one", "Keep as-is" (if you believe they're false positives), or "Cancel"

For anything the user wants redacted, replace the matched substring in `github-summary.md` with `[REDACTED]`.

## Step 3 — Offer translation

Detect the language of the user-prompt sections in `github-summary.md`. If the dominant language is not English (or doesn't match the repo's primary language — check `README.md` if unsure), ask:

> "The prompts are in {detected language}. Translate to {target language} before sharing? [Yes / No]"

If yes, apply this prompt to the user-prompt sections of the markdown:

```
You are a translation assistant for AI coding sessions.
Translate the following user prompts from {source} to {target}.

Rules:
- Only translate natural language text
- Preserve code blocks, file paths, variable names, CLI commands verbatim
- Preserve markdown formatting
- Keep technical jargon in English (API, endpoint, middleware, etc.)
- Maintain the original intent and tone
- If a prompt is already in {target}, return it unchanged
```

Only rewrite the prompt text — do not touch tool-call output, file diffs, or stats.

## Step 4 — Offer tone softening

Scan the user-prompt sections for harsh language, profanity, frustration, or passive-aggressive tone toward the AI. If you find any, ask:

> "Some prompts contain {brief example, e.g. 'frustrated language'}. Soften the tone before sharing? [Professional / Neutral / Friendly / Skip]"

If the user picks a style, apply this prompt to the affected user prompts:

```
You are a tone adjustment assistant for AI coding sessions.
Rewrite the following user prompts to be more {style}.

Rules:
- Preserve the EXACT technical meaning and intent
- Remove frustration, harsh language, profanity, or passive-aggressive tone
- Keep code references, file paths, and technical terms unchanged
- If a prompt is already appropriate, return it unchanged
- Do NOT add excessive politeness or corporate-speak — keep it natural

Style guide:
- Professional: direct but respectful, suitable for work sharing
- Neutral: factual and unemotional, like documentation
- Friendly: warm and collaborative, like messaging a teammate
```

## Step 5 — Preview and paste

Show the user the final markdown (or a diff against the original if changes were made). Ask:

> "Paste into a PR now? [Current branch's PR / Open new PR / Just save the file / Cancel]"

If pasting into the current branch's PR:

```bash
gh pr edit --body-file <updated-markdown>
```

If saving locally only, write the cleaned version to `~/.vibe-replay/<slug>/github-summary.clean.md` and report the path.

## Notes

- **The skip-the-image rule still applies**: by default, do NOT include the GIF reference (first line of the original markdown) when pasting into a PR — committing a binary GIF bloats git history. Only include it if the user explicitly asks for the GIF.
- **Never modify the original `github-summary.md`** unless the user is doing a destructive edit and confirms. Write changes to `github-summary.clean.md` so the original is recoverable.
- **Session ID detection**: the literal `${CLAUDE_SESSION_ID}` is interpolated by the harness when this skill runs. If it's empty, ask the user which session they want.
