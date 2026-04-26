# Prompts

Top-level home for AI prompts that are shared across the project. Kept at the repo root (not under any one package) because multiple consumers reference the same text:

- **Replay skill** (`skills/replay/SKILL.md`) — *current consumer*. The prompt text is inlined verbatim into SKILL.md so an agent applies the same instructions when assisting with PR sharing.
- **AI Studio** (*planned* — see `plan/features/003-ai-studio.md`) — *not yet wired*. When implemented, server-side code in `packages/cli/src/server.ts` will read these files before invoking a headless CLI tool to translate or adjust tone.

If you change a prompt here, also update the inline copy in `skills/replay/SKILL.md` so the two stay in sync. Frequency is low — a build-time sync script is overkill for now.
