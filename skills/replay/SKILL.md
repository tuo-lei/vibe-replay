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

If the user chooses to redact any finding, **first copy the original to a working file** (do not overwrite `github-summary.md`):

```bash
cp ~/.vibe-replay/<slug>/github-summary.md ~/.vibe-replay/<slug>/github-summary.clean.md
```

Then apply replacements to `github-summary.clean.md`. The original stays intact so the user can recover the unedited version. All later steps (translation, tone) also operate on the `.clean.md` copy — create it on the first edit, then keep using it.

## Step 3 — Offer translation

Read the working file (`github-summary.clean.md` if it exists from step 2, otherwise `github-summary.md`):

```bash
cat ~/.vibe-replay/<slug>/github-summary.clean.md 2>/dev/null || cat ~/.vibe-replay/<slug>/github-summary.md
```

Detect the language of the user-prompt sections. If the dominant language is not English (or doesn't match the repo's primary language — check `README.md` if unsure), ask:

> "The prompts are in {detected language}. Translate to {target language} before sharing? [Yes / No]"

If yes, apply this prompt to the user-prompt sections of the markdown (always write the result to `github-summary.clean.md`, creating it from a copy of the original if it doesn't exist yet):

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

If the user picks a style, apply this prompt to the affected user prompts (write the result to `github-summary.clean.md`, same rule as step 3):

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

> "Paste into a PR now? [Append to current PR's body / Replace current PR's body / Open new PR / Just save the file / Cancel]"

**Important**: `gh pr edit --body-file <file>` **replaces** the entire PR body. If the user already has a hand-written summary, checklist, or screenshots in the PR body, replacing wipes them silently. Default to **appending** under a `## Session Replay` heading instead.

To append (recommended default):

```bash
# Read existing body, then write existing + separator + cleaned summary
gh pr view --json body --jq .body > /tmp/pr-body.md
echo "" >> /tmp/pr-body.md
echo "---" >> /tmp/pr-body.md
echo "" >> /tmp/pr-body.md
echo "## Session Replay" >> /tmp/pr-body.md
echo "" >> /tmp/pr-body.md
cat ~/.vibe-replay/<slug>/github-summary.clean.md >> /tmp/pr-body.md
gh pr edit --body-file /tmp/pr-body.md
```

To replace (only if the user explicitly chooses this — confirm out loud what's about to be lost first):

```bash
gh pr edit --body-file ~/.vibe-replay/<slug>/github-summary.clean.md
```

If saving locally only, the cleaned version is already at `~/.vibe-replay/<slug>/github-summary.clean.md` from earlier steps — just report the path. If no cleanup steps ran, copy the original first so the user has a `.clean.md` to share without touching the source.

## Notes

- **The skip-the-image rule still applies**: by default, do NOT include the GIF reference (first line of the original markdown) when pasting into a PR — committing a binary GIF bloats git history. Only include it if the user explicitly asks for the GIF.
- **`github-summary.clean.md` is the only file the skill writes to**. The original `github-summary.md` is treated as read-only so the user can always recover the raw output.
- **Session ID detection**: the literal `${CLAUDE_SESSION_ID}` is interpolated by the harness when this skill runs. If it's empty, ask the user which session they want.
