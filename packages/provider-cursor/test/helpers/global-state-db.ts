import initSqlJs from "sql.js";

export const GLOBAL_STATE_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

export async function globalStateDbBytes(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(
      "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);",
    );
    for (const [index, id] of GLOBAL_STATE_IDS.entries()) {
      const headers = [{ bubbleId: "user" }, { bubbleId: "answer" }];
      db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
        `composerData:${id}`,
        JSON.stringify({
          name: `Readonly task ${index + 1}`,
          createdAt: 1800000000000,
          fullConversationHeadersOnly: headers,
        }),
      ]);
      db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
        `bubbleId:${id}:user`,
        JSON.stringify({ type: 1, text: `Fix readonly output ${index + 1}` }),
      ]);
      db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
        `bubbleId:${id}:answer`,
        JSON.stringify({ type: 2, text: `Done ${index + 1}` }),
      ]);
    }
    return db.export();
  } finally {
    db.close();
  }
}
