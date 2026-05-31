# vibe-replay

[![npm version](https://img.shields.io/npm/v/vibe-replay)](https://www.npmjs.com/package/vibe-replay)
[![npm downloads](https://img.shields.io/npm/dm/vibe-replay)](https://www.npmjs.com/package/vibe-replay)
[![license](https://img.shields.io/npm/l/vibe-replay)](./LICENSE)

Turn Claude Code, Cursor, and Codex sessions into shareable, interactive replays.

### The problem

AI agents write code in long, complex sessions — dozens of tool calls, hundreds of file edits, thousands of lines of reasoning. When the session ends, all that context disappears. Your PR diff shows _what_ changed, but reviewers can't see _why_. Teammates can't learn from your prompting. You can't even replay your own session next week.

### The fix

One command. One self-contained HTML file. Every prompt, every thought, every tool call — animated and interactive.

```bash
npx vibe-replay
```

> Also available as a [Claude Code plugin](#claude-code-plugin) — your agent generates replays automatically during PR creation.

> **[Watch a live demo &rarr;](https://vibe-replay.com/view/?gist=c40137e4c224dc883fe2eaa668e2d8ba)**

<p align="center">
  <img src="docs/screenshots/product-demo.gif" alt="vibe-replay product demo" width="600" />
</p>


## What You Get

### All your sessions, one place

Launch with `npx vibe-replay -d` and see every Claude Code, Cursor, and Codex session across all projects — with activity heatmaps, cost totals, and project analytics.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Local dashboard — browse sessions, activity heatmap, project analytics" width="800" />
</p>

### Watch the full replay

Pick a session and step through every prompt, thinking block, tool call, and code diff with animated playback. Three view modes — All, Compact, and Custom.

<p align="center">
  <a href="https://vibe-replay.com/view/?gist=c40137e4c224dc883fe2eaa668e2d8ba">
    <img src="docs/screenshots/compact-mode.png" alt="Animated replay — syntax-highlighted diffs, tool calls, and thinking blocks" width="800" />
  </a>
</p>

### Deep insights for every session

Auto-generated analytics: token burn & cost over time, context window usage, cache hit rates, tool call distribution, model breakdown, and per-turn breakdowns.

<p align="center">
  <img src="docs/screenshots/insights.png" alt="Session insights — token usage, cost tracking, tool distribution, and context window charts" width="800" />
</p>

### Your AI coding wrapped

GitHub-style activity heatmap, streaks, weekly trends, top projects, model usage, and cost tracking across all your sessions. See how your coding patterns evolve over time.

<p align="center">
  <img src="docs/screenshots/personal-insights.png" alt="Personal insights — GitHub-style heatmap, streaks, session stats, and cost tracking" width="800" />
</p>

## Claude Code Plugin

vibe-replay is also available as a [Claude Code plugin](https://code.claude.com/docs/en/plugins). Once installed, your agent learns how to generate replays autonomously — it can find the current session, produce GitHub-ready artifacts, and embed them in PRs, all without you running any CLI commands.

### What the plugin gives your agent

- **Auto-discover sessions** — finds the current session's JSONL file via `$CLAUDE_SESSION_ID`
- **Generate PR artifacts** — markdown summary + animated GIF + SVG, ready for PR descriptions
- **Generate HTML replays** — self-contained interactive replay files
- **PR workflow integration** — agent automatically embeds replay context when you create PRs

### Install (recommended)

Open Claude Code, run `/plugin`, then search **vibe-replay** in the **Discover** tab and install.

Or install via CLI:

```bash
/plugin marketplace add tuo-lei/vibe-replay
/plugin install vibe-replay@vibe-replay
```

### Manual install (single file)

If you prefer not to install the full plugin:

```bash
mkdir -p ~/.claude/skills/replay
curl -o ~/.claude/skills/replay/SKILL.md \
  https://raw.githubusercontent.com/tuo-lei/vibe-replay/main/skills/replay/SKILL.md
```

### Usage examples

```
# Slash command — generate a replay of the current session
/vibe-replay:replay

# Natural language — agent auto-triggers during PR creation
"Create a PR with session replay"
"Create a PR for this change, include an animated GIF of the session"

# Direct replay
"Generate an interactive replay of this session and open it"
```

## Features

- **Zero config** — one command, no setup, no account. Works instantly with existing sessions
- **Single HTML file** — self-contained, works offline, zero external requests. Drop it in Slack, email it, open it anywhere
- **Claude Code, Cursor, and Codex** — all providers auto-discovered, including multi-file and resumed sessions
- **Share & export** — GitHub Gist, animated SVG, GIF, markdown summary, or cloud upload. Secret redaction built in
- **Sub-agent visualization** — see delegated tool calls and sub-agent trees rendered inline
- **Comments** — leave notes on any scene. Comments persist in the HTML and travel with the replay
- **Live mode** — `vibe-replay live` streams a running Claude Code or Codex session into the viewer, pinned to the latest turn as it lands on disk

## Supported Providers

| Provider | Status |
|----------|--------|
| Claude Code | Supported |
| Claude Desktop | Supported |
| Claude Cowork | Supported (agent-mode sessions) |
| Codex | Supported (web search, GPT-5.x models, task timings, memory mode) |
| Cursor | Supported (SQLite + JSONL + SDK store, auto-discovered) |
| More coming soon | — |

## How It Works

```
AI session files  →  vibe-replay  →  self-contained HTML
(Claude Code,        (discover,       (animated viewer,
 Cursor, Codex)       parse,           insights panel,
                      redact,          offline-ready,
                      transform)       shareable)
```

The CLI auto-discovers sessions on your machine, parses conversation data from all sources, and packages everything into a pre-built React viewer — one HTML file that works anywhere.

**After generation:**
- **Open in Editor** — annotate scenes, get AI feedback, export to multiple formats
- **Quick preview** — open in browser instantly
- **Publish to Gist** — shareable link on [vibe-replay.com](https://vibe-replay.com)
- **Export for GitHub** — markdown + animated SVG for PRs

## Use Cases

- **Vibe coding review** — replay your AI-assisted coding sessions to spot prompting patterns and improve your workflow
- **Team knowledge sharing** — show teammates _how_ you built something, not just the final diff
- **PR context** — attach a replay link to PRs so reviewers understand the reasoning behind changes
- **Teaching & onboarding** — create replayable walkthroughs of real coding sessions for documentation or training
- **Cost tracking** — see exactly how many tokens each session burns, track costs across projects

## Security & Privacy

- **Self-contained HTML** — generated replay files embed all assets inline. When opened from disk they make zero external requests — works offline, behind firewalls, on an airplane. (Gist/cloud-backed replays fetch data from GitHub or vibe-replay API on load)
- **Secret redaction** — API keys, tokens, PEM keys, and sensitive paths are automatically detected and redacted before generation
- **Local by default** — vibe-replay reads session files from your machine and generates a local HTML file. Data only leaves your machine when you explicitly publish (Gist or cloud upload), or if you log in — in which case aggregated session insights (counts, durations, costs — no conversation content) sync daily to the cloud
- **No wrappers, no proxies** — vibe-replay does not modify, intercept, or wrap Claude Code or Cursor. It reads existing session logs after the fact

## Development

```bash
git clone https://github.com/tuo-lei/vibe-replay.git
cd vibe-replay
pnpm install
pnpm dev              # Viewer (Vite HMR) + CLI (auto-restart) — full HMR
pnpm dev:website      # Website (Astro HMR) + Viewer (Vite HMR)
```

CLI usage requires Node.js >= 20. The `website` package uses Astro 6 and requires Node.js >= 22.12.0. When `nvm` is available, `website` scripts will try `nvm use` from `website/.nvmrc` automatically.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for architecture details and development workflow.

## License

[MIT](./LICENSE)
