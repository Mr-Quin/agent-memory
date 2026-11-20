import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentUpsertSql } from "../src/document-sql.function";

const usage = "usage: bun scripts/push-document.script.ts <name> <file> (--local | --remote) [wrangler flags, e.g. --env scratch -c wrangler.local.jsonc]";
const [name, file, ...rest] = process.argv.slice(2);
if (!name || !file || !(rest.includes("--local") || rest.includes("--remote"))) {
  console.error(usage);
  process.exit(2);
}

const content = readFileSync(file, "utf8");
const dir = mkdtempSync(join(tmpdir(), "push-document-"));
const sqlFile = join(dir, "document.sql");
try {
  writeFileSync(sqlFile, documentUpsertSql(name, content, Date.now() / 1000));
  const run = Bun.spawnSync(["bunx", "wrangler", "d1", "execute", "DB", "--file", sqlFile, "--yes", ...rest], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);
  console.log(`Pushed document "${name}" (${content.length} characters)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
