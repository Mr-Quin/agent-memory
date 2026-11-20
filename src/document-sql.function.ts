export const DOCUMENTS_DDL =
  "CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at REAL NOT NULL);";

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

export function documentUpsertSql(name: string, content: string, now: number): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid document name: ${name}`);
  if (content.includes("\0")) throw new Error("Document content contains a NUL byte");
  return [
    DOCUMENTS_DDL,
    `INSERT INTO documents (name, content, updated_at) VALUES (${quote(name)}, ${quote(content)}, ${now})`,
    "  ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at;",
  ].join("\n");
}
