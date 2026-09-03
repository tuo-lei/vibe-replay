import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

export async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
}

export async function applyMigrations(db: D1Database, through?: string): Promise<void> {
  for (const file of await migrationFiles()) {
    if (through && file > through) break;
    await applyMigration(db, file);
  }
}

export async function applyMigration(db: D1Database, file: string): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}
