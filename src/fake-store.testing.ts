import type { MemoryUpdate } from "./manage.function";
import type { MemoryRecord } from "./memory-record.function";
import type { AccessUpdate, StoredMemory } from "./search.function";
import type { CallContext, MemoryStore } from "./tools.function";

// Embeds by bag of letters, so texts that share words land near each other.
function letterVector(text: string): number[] {
  const v = Array.from({ length: 26 }, () => 0);
  for (const c of text.toLowerCase()) {
    const i = c.charCodeAt(0) - 97;
    if (i >= 0 && i < 26) v[i] = (v[i] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export class FakeStore implements MemoryStore {
  rows: (StoredMemory & { store: string; vector: number[] })[] = [];
  access: AccessUpdate[] = [];
  embedded: string[] = [];

  embedCalls = 0;
  async embed(texts: string[]) {
    this.embedCalls += 1;
    this.embedded.push(...texts);
    return texts.map(letterVector);
  }
  async activeHashes(hashes: string[]) {
    return new Set(this.rows.filter((r) => hashes.includes(r.contentHash)).map((r) => r.contentHash));
  }
  async insert(records: MemoryRecord[], embeddings: number[][], store: string) {
    for (const [i, record] of records.entries()) this.insertOne(record, embeddings[i] ?? [], store);
  }
  private insertOne(record: MemoryRecord, embedding: number[], store: string) {
    this.rows.push({
      contentHash: record.contentHash,
      vectorId: record.contentHash,
      content: record.content,
      tags: record.tags,
      memoryType: record.memoryType,
      metadata: record.metadataJson ? JSON.parse(record.metadataJson) : {},
      createdAt: record.createdAt,
      createdAtIso: record.createdAtIso,
      store,
      vector: embedding,
    });
  }
  async nearest(vector: number[], topK: number) {
    const dot = (a: number[]) => a.reduce((s, x, i) => s + x * (vector[i] ?? 0), 0);
    return [...this.rows].sort((a, b) => dot(b.vector) - dot(a.vector)).slice(0, topK).map((r) => r.vectorId);
  }
  private scoped(store: string | null) {
    return this.rows.filter((r) => store === null || r.store === store);
  }
  async byVectorIds(ids: string[], store: string | null) {
    return this.scoped(store).filter((r) => ids.includes(r.vectorId));
  }
  async byHash(hash: string, store: string | null) {
    return this.scoped(store).find((r) => r.contentHash === hash) ?? null;
  }
  async containing(text: string, store: string | null) {
    return this.scoped(store).filter((r) => r.content.toLowerCase().includes(text.toLowerCase()));
  }
  async recent(store: string | null) {
    return [...this.scoped(store)].sort((a, b) => b.createdAt - a.createdAt);
  }
  async recordAccess(updates: AccessUpdate[]) {
    this.access.push(...updates);
  }
  deleted: string[] = [];
  documents = new Map<string, string>();
  async softDelete(memories: StoredMemory[]) {
    const hashes = new Set(memories.map((m) => m.contentHash));
    this.deleted.push(...hashes);
    this.rows = this.rows.filter((r) => !hashes.has(r.contentHash));
  }
  async update(contentHash: string, update: MemoryUpdate) {
    const row = this.rows.find((r) => r.contentHash === contentHash);
    if (!row) return;
    if (update.memoryType !== undefined) row.memoryType = update.memoryType;
    if (update.metadataJson !== undefined) row.metadata = JSON.parse(update.metadataJson);
    if (update.tags !== undefined) row.tags = update.tags;
    row.updatedAt = update.updatedAt;
    row.updatedAtIso = update.updatedAtIso;
  }
  async deletedCount() {
    return this.deleted.length;
  }
  async document(name: string) {
    return this.documents.get(name) ?? null;
  }
  async documentNames() {
    return [...this.documents.keys()].sort();
  }
}

export function fakeContext(store: FakeStore, agentIdHeader?: string): CallContext & { deferred: Promise<unknown>[] } {
  let t = 1795150000;
  const deferred: Promise<unknown>[] = [];
  return {
    store,
    agentIdHeader,
    now: () => (t += 1),
    trackAccess: true,
    defer: (p) => deferred.push(p),
    deferred,
  };
}
