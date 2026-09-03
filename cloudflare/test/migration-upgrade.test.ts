import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./migration-utils";

const LEGACY_USER_ID = "legacy-user";

let mf: Miniflare;
let db: D1Database;

describe("D1 migration upgrades", () => {
  beforeAll(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      compatibilityDate: "2024-12-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
    });
    db = (await mf.getBindings()).DB as D1Database;
  });

  afterAll(async () => {
    await mf.dispose();
  });

  it("upgrades a populated pre-issuer account table", async () => {
    await applyMigrations(db, "0008_add_insight_profiles.sql");
    await db
      .prepare("INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, ?)")
      .bind(LEGACY_USER_ID, "Legacy User", "legacy-user", 1)
      .run();
    await db
      .prepare("INSERT INTO account (id, account_id, provider_id, user_id) VALUES (?, ?, ?, ?)")
      .bind("legacy-account", "github-subject", "github", LEGACY_USER_ID)
      .run();

    const beforeColumns = await db.prepare("PRAGMA table_info(account)").all<{ name: string }>();
    expect(beforeColumns.results.map((column) => column.name)).not.toContain("issuer");

    await applyMigration(db, "0009_add_account_issuer.sql");

    const account = await db
      .prepare("SELECT issuer FROM account WHERE id = ?")
      .bind("legacy-account")
      .first<{ issuer: string }>();
    expect(account?.issuer).toBe("local:oauth:github");

    const issuerIndex = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .bind("account_issuer_accountId_uidx")
      .first<{ sql: string }>();
    expect(issuerIndex?.sql).toContain("issuer");
    expect(issuerIndex?.sql).toContain("account_id");
  });
});
