import { groupTags, insertParams, type MemoryRow, placeholders, rowToMemory, vectorMetadata } from "./d1-rows.function";
import type { MemoryRecord } from "./memory-record.function";
import type { AccessUpdate, StoredMemory } from "./search.function";
import type { MemoryStore } from "./tools.function";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const INSERT_SQL = `INSERT INTO memories (
  content_hash, content, memory_type, created_at, created_at_iso,
  updated_at, updated_at_iso, metadata_json, vector_id, content_size, r2_key, tags, store
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const LINK_TAG_SQL = `INSERT OR IGNORE INTO memory_tags (memory_id, tag_id)
  SELECT m.id, t.id FROM memories m, tags t
  WHERE m.content_hash = ? AND m.deleted_at IS NULL AND t.name = ?`;

const ACCESS_SQL = `UPDATE memories SET metadata_json = json_set(
    coalesce(nullif(metadata_json, ''), '{}'),
    '$.access_count', CAST(? AS INTEGER), '$.last_accessed_at', ?, '$.access_queries', json(?))
  WHERE content_hash = ? AND (metadata_json IS NULL OR metadata_json = '' OR json_valid(metadata_json))`;

export class CloudflareMemoryStore implements MemoryStore {
  constructor(private readonly env: Env) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out = (await this.env.AI.run(EMBEDDING_MODEL, { text: texts })) as { data?: number[][] };
    if (out.data?.length !== texts.length) throw new Error("Embedding generation failed: Workers AI returned no vectors");
    return out.data;
  }

  async activeHashes(hashes: string[]): Promise<Set<string>> {
    if (!hashes.length) return new Set();
    const { results } = await this.env.DB.prepare(
      `SELECT content_hash FROM memories WHERE deleted_at IS NULL AND content_hash IN (${placeholders(hashes.length)})`,
    )
      .bind(...hashes)
      .all<{ content_hash: string }>();
    return new Set(results.map((r) => r.content_hash));
  }

  async insert(records: MemoryRecord[], embeddings: number[][], store: string): Promise<void> {
    await this.env.VECTORIZE.upsert(
      records.map((record, i) => ({ id: record.contentHash, values: embeddings[i] ?? [], metadata: vectorMetadata(record) })),
    );
    const db = this.env.DB;
    await db.batch(
      records.flatMap((record) => [
        db.prepare("DELETE FROM memories WHERE content_hash = ? AND deleted_at IS NOT NULL").bind(record.contentHash),
        db.prepare(INSERT_SQL).bind(...insertParams(record, store)),
        ...record.tags.flatMap((tag) => [
          db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").bind(tag),
          db.prepare(LINK_TAG_SQL).bind(record.contentHash, tag),
        ]),
      ]),
    );
  }

  async nearest(vector: number[], topK: number): Promise<string[]> {
    const { matches } = await this.env.VECTORIZE.query(vector, { topK, returnMetadata: "none", returnValues: false });
    return matches.map((m) => m.id);
  }

  // D1 refuses a statement with more than 100 bound parameters.
  async byVectorIds(ids: string[], store: string | null): Promise<StoredMemory[]> {
    const out: StoredMemory[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const slice = ids.slice(i, i + 90);
      out.push(...(await this.load(`vector_id IN (${placeholders(slice.length)})`, slice, store)));
    }
    return out;
  }

  async byHash(hash: string, store: string | null): Promise<StoredMemory | null> {
    const [memory] = await this.load("content_hash = ?", [hash], store);
    return memory ?? null;
  }

  containing(text: string, store: string | null): Promise<StoredMemory[]> {
    const escaped = text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    return this.load("content LIKE '%' || ? || '%' ESCAPE '\\'", [escaped], store, "ORDER BY created_at DESC");
  }

  recent(store: string | null): Promise<StoredMemory[]> {
    return this.load("1 = 1", [], store, "ORDER BY created_at DESC");
  }

  async recordAccess(updates: AccessUpdate[]): Promise<void> {
    const db = this.env.DB;
    await db.batch(
      updates.map((u) =>
        db.prepare(ACCESS_SQL).bind(u.accessCount, u.lastAccessedAt, JSON.stringify(u.accessQueries), u.contentHash),
      ),
    );
  }

  private async load(where: string, params: unknown[], store: string | null, order = ""): Promise<StoredMemory[]> {
    const storeSql = store === null ? "" : " AND store = ?";
    const { results: rows } = await this.env.DB.prepare(
      `SELECT * FROM memories WHERE ${where} AND deleted_at IS NULL${storeSql} ${order}`,
    )
      .bind(...params, ...(store === null ? [] : [store]))
      .all<MemoryRow>();
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const tags = new Map<number, string[]>();
    for (let i = 0; i < ids.length; i += 90) {
      const slice = ids.slice(i, i + 90);
      const { results } = await this.env.DB.prepare(
        `SELECT mt.memory_id, t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.memory_id IN (${placeholders(slice.length)}) ORDER BY mt.rowid`,
      )
        .bind(...slice)
        .all<{ memory_id: number; name: string }>();
      for (const [id, names] of groupTags(results)) tags.set(id, names);
    }
    return rows.map((row) => rowToMemory(row, tags.get(row.id) ?? []));
  }
}
