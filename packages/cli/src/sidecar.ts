import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export class SidecarError extends Error {
  readonly code = "invalid-sidecar";
  readonly suggestions: string[];
  constructor(path: string) {
    super(
      `Cannot safely read saved edits from ${path}. Restore a valid backup before exporting or sharing. To deliberately reparse the original, use --source with its source session reference.`,
    );
    this.suggestions = [
      "Restore the sidecar from a valid backup",
      "Use --source with the original source session reference to deliberately discard saved edits",
    ];
  }
}

/** Strict workflow reads distinguish optional absence from a damaged saved edit. */
export async function readSidecar<T>(
  path: string,
  valid: (value: unknown) => boolean,
  strict: boolean,
): Promise<T | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (!valid(value)) throw new Error("Invalid sidecar structure");
    return value as T;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw new SidecarError(path);
    return undefined;
  }
}

/** Same-directory replacement keeps interrupted saves from truncating existing edits. */
export async function writeSidecar(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
