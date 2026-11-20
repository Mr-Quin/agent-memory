import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { documentUpsertSql } from "./document-sql.function";

test("creates the table, then inserts or replaces the document, quoting safely", () => {
  const db = new Database(":memory:");
  const tricky = "It's a test'); DROP TABLE documents; --\nline two";
  db.exec(documentUpsertSql("persona", "first", 1));
  db.exec(documentUpsertSql("persona", tricky, 2));
  expect(db.query("SELECT name, content, updated_at FROM documents").all()).toEqual([
    { name: "persona", content: tricky, updated_at: 2 },
  ]);
});

test("refuses names that are not plain identifiers", () => {
  expect(() => documentUpsertSql("../x", "c", 1)).toThrow("Invalid document name");
  expect(() => documentUpsertSql("Persona", "c", 1)).toThrow("Invalid document name");
});
