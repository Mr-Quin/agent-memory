import type { MemoryRecord } from "./memory-record.function";
import type { StoredMemory } from "./search.function";

export interface MemoryRow {
  id: number;
  content_hash: string;
  content: string;
  memory_type: string | null;
  created_at: number;
  created_at_iso: string;
  metadata_json: string | null;
  vector_id: string | null;
}

export function rowToMemory(row: MemoryRow, tags: string[]): StoredMemory {
  let metadata: Record<string, unknown> = {};
  if (row.metadata_json) {
    try {
      const parsed: unknown = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    contentHash: row.content_hash,
    vectorId: row.vector_id ?? row.content_hash,
    content: row.content,
    tags,
    memoryType: row.memory_type,
    metadata,
    createdAt: row.created_at,
    createdAtIso: row.created_at_iso,
  };
}

export function groupTags(links: { memory_id: number; name: string }[]): Map<number, string[]> {
  const byMemory = new Map<number, string[]>();
  for (const { memory_id, name } of links) {
    const list = byMemory.get(memory_id) ?? [];
    list.push(name);
    byMemory.set(memory_id, list);
  }
  return byMemory;
}

export function insertParams(record: MemoryRecord, store: string): unknown[] {
  return [
    record.contentHash,
    record.content,
    record.memoryType,
    record.createdAt,
    record.createdAtIso,
    record.createdAt,
    record.createdAtIso,
    record.metadataJson,
    record.contentHash,
    record.contentSize,
    null,
    record.tags.length ? record.tags.join(",") : null,
    store,
  ];
}

export function vectorMetadata(record: MemoryRecord): Record<string, string> {
  return {
    content_hash: record.contentHash,
    memory_type: record.memoryType || "standard",
    tags: record.tags.join(","),
    created_at: record.createdAtIso,
  };
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
