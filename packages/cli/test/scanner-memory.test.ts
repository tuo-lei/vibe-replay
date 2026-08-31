import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectMemory } from "../src/scanner.js";

describe("readProjectMemory", () => {
  it("reads memory from a Windows Claude project slug", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-scanner-memory-"));
    const projectsDir = join(root, "projects");
    const encodedDir = join(projectsDir, "C--Users-test-vibe-replay");
    await mkdir(encodedDir, { recursive: true });
    await writeFile(join(encodedDir, "CLAUDE.md"), "Windows project memory");

    const memory = await readProjectMemory(
      "C:\\Users\\test\\vibe-replay",
      projectsDir,
      "win32",
      join(root, "home"),
    );

    expect(memory).toEqual({
      memoryFiles: [],
      claudeMd: "Windows project memory",
    });
  });

  it("expands Windows tilde paths before encoding them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-scanner-memory-"));
    const projectsDir = join(root, "projects");
    const encodedDir = join(projectsDir, "C--Users-test-Code-vibe-replay");
    await mkdir(encodedDir, { recursive: true });
    await writeFile(join(encodedDir, "CLAUDE.md"), "Tilde project memory");

    const memory = await readProjectMemory(
      "~\\Code\\vibe-replay",
      projectsDir,
      "win32",
      "C:\\Users\\test",
    );

    expect(memory).toEqual({
      memoryFiles: [],
      claudeMd: "Tilde project memory",
    });
  });

  it("keeps POSIX project slugs unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-scanner-memory-"));
    const projectsDir = join(root, "projects");
    const encodedDir = join(projectsDir, "-Users-test-vibe-replay");
    await mkdir(encodedDir, { recursive: true });
    await writeFile(join(encodedDir, "CLAUDE.md"), "POSIX project memory");

    const memory = await readProjectMemory(
      "/Users/test/vibe-replay",
      projectsDir,
      "linux",
      "/home/test",
    );

    expect(memory).toEqual({
      memoryFiles: [],
      claudeMd: "POSIX project memory",
    });
  });
});
