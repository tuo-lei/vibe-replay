# Prompts

Top-level home for AI prompts that are shared across the project. Kept at the repo root (not under any one package) because multiple consumers reference the same text:

- **AI Studio** (`packages/cli/src/server.ts` + viewer panel, see `plan/features/003-ai-studio.md`) — server-side code reads these files when invoking a headless CLI tool to translate or adjust tone.
- **Replay skill** (`skills/replay/SKILL.md`) — the same prompt text is inlined into the skill so an agent applies the same instructions when assisting with PR sharing.

If you change a prompt here, also update the inline copy in `skills/replay/SKILL.md` so the two stay in sync. Frequency is low — a build-time sync script is overkill for now.
