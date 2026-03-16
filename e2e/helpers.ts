import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOutput } from "../packages/cli/src/generator.ts";
import { parseClaudeCodeSession } from "../packages/cli/src/providers/claude-code/parser.ts";
import { transformToReplay } from "../packages/cli/src/transform.ts";
import type { ReplaySession } from "../packages/types/src/index.ts";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "packages/cli/test/fixtures/claude-code-session.jsonl",
);

/**
 * Full pipeline: parse fixture → transform → generate HTML.
 * Returns paths and the session data for assertions.
 */
export async function generateTestReplay(): Promise<{
  htmlPath: string;
  session: ReplaySession;
  tmpDir: string;
}> {
  const parsed = await parseClaudeCodeSession(FIXTURE);
  const session = transformToReplay(parsed, "claude-code", "~/test-project", {
    generator: {
      name: "vibe-replay",
      version: "0.0.0-test",
      generatedAt: new Date().toISOString(),
    },
  });

  const tmpDir = join(tmpdir(), `vibe-replay-e2e-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  // Generate into a slug-based subdirectory (mirrors real usage)
  const slug = session.meta.slug || "test-session";
  const outputDir = join(tmpDir, slug);
  const htmlPath = await generateOutput(session, outputDir);

  return { htmlPath, session, tmpDir };
}

/**
 * Read the generated HTML file content.
 */
export async function readGeneratedHtml(htmlPath: string): Promise<string> {
  return readFile(htmlPath, "utf-8");
}
