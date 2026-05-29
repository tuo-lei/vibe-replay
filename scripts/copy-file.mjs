#!/usr/bin/env node
// Cross-platform replacement for `mkdir -p <dir> && cp <src> <dest>`.
// Windows shells lack `mkdir -p`/`cp`, so build scripts shell out here instead.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error("usage: copy-file.mjs <src> <dest>");
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
