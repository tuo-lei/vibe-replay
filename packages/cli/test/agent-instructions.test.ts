import { readFile, readlink, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the cross-agent instruction wiring described under "Agent setup" in
// AGENTS.md. Every supported coding agent has to end up reading the same file:
//
//   Codex / Cursor / Pi / opencode -> AGENTS.md natively
//   Claude Code                    -> CLAUDE.md, which imports AGENTS.md
//
// These are filesystem contracts, not implementation details. If one breaks, an
// agent silently works with no project instructions at all, which is very hard
// to notice from inside a session.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

// Codex's default `project_doc_max_bytes`. Past this Codex truncates AGENTS.md
// and stops reading later sections without reporting anything. See the
// "Size limit" subsection of AGENTS.md for how to split the file instead of
// raising this number.
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

// CLAUDE.md is a shim: an `@AGENTS.md` import plus Claude-Code-only notes. A
// budget keeps project knowledge from drifting back into it, where Codex,
// Cursor, Pi, and opencode would never see it.
const CLAUDE_SHIM_MAX_BYTES = 4 * 1024;

describe("AGENTS.md", () => {
  it("is the single source of truth and stays under Codex's project doc limit", async () => {
    const agents = await readFile(join(REPO_ROOT, "AGENTS.md"), "utf-8");

    expect(agents).toContain("# AGENTS.md — vibe-replay");
    expect(Buffer.byteLength(agents, "utf-8")).toBeLessThan(CODEX_PROJECT_DOC_MAX_BYTES);
  });
});

describe("CLAUDE.md", () => {
  it("imports AGENTS.md so Claude Code reads the shared instructions", async () => {
    const claude = await readFile(join(REPO_ROOT, "CLAUDE.md"), "utf-8");

    // Claude Code only expands `@path` outside code spans and fenced blocks, so
    // the import has to sit on its own line in prose. Anchor to the first line.
    expect(claude.split("\n")[0].trim()).toBe("@AGENTS.md");
  });

  it("stays a thin shim rather than a second source of truth", async () => {
    const claude = await readFile(join(REPO_ROOT, "CLAUDE.md"), "utf-8");

    expect(Buffer.byteLength(claude, "utf-8")).toBeLessThan(CLAUDE_SHIM_MAX_BYTES);
  });
});

// `skills/replay/` is the published copy: `.claude-plugin/plugin.json` points at
// `./skills/`, and the README's manual-install command curls its raw URL. It is
// therefore the one real directory, and each agent's discovery location is a
// symlink into it rather than a copy.
const SKILL_SOURCE = join(REPO_ROOT, "skills", "replay");

describe("replay skill", () => {
  it("has exactly one real copy, at the published skills/ path", async () => {
    const skill = await readFile(join(SKILL_SOURCE, "SKILL.md"), "utf-8");

    expect(skill.startsWith("---")).toBe(true);
    expect(skill).toContain("name: replay");
  });

  // `.agents/skills/` is where Codex and Pi look; `.claude/skills/` is where
  // Claude Code looks. Both must reach the same file.
  it.each([
    [".agents", "Codex and Pi"],
    [".claude", "Claude Code"],
  ])("is discoverable under %s/skills for %s", async (dir) => {
    const link = join(REPO_ROOT, dir, "skills", "replay");

    // `readlink` rather than `lstat().isSymbolicLink()`: on a Windows clone
    // without symlink support git materializes the entry as a text file, and
    // this assertion names that failure directly.
    const target = await readlink(link);
    expect(resolve(dirname(link), target)).toBe(SKILL_SOURCE);

    // Resolving through the link has to reach a real directory, which catches a
    // skill that was moved or renamed without updating the link.
    const resolved = await stat(link);
    expect(resolved.isDirectory()).toBe(true);
  });
});
