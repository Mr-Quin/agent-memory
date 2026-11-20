import { coerceMemoryType, isoUtc, normalizeTags, pythonJson } from "./memory-record.function";
import { hasAllOrAny, memoryAgentId, type StoredMemory } from "./search.function";

export interface ListRequest {
  page: number;
  pageSize: number;
  tags: string[];
  tagMatch: "any" | "all";
  memoryType?: string;
  staleDays?: number;
  agentId?: string;
  store: string | null;
}

const LIST_ARGS = new Set(["page", "page_size", "tags", "tag_match", "memory_type", "stale_days", "store", "agent_id"]);
const DELETE_ARGS = new Set(["content_hash", "tags", "tag_match", "before", "after", "dry_run", "store"]);

function unsupported(args: Record<string, unknown>, allowed: Set<string>): string | undefined {
  const extra = Object.keys(args).filter((k) => !allowed.has(k) && args[k] !== undefined && args[k] !== null);
  return extra.length ? `not supported by this server: ${extra.sort().join(", ")}` : undefined;
}

function storeOf(value: unknown): string | null {
  return value === "all" ? null : value === undefined ? "default" : String(value);
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export function parseListArgs(args: Record<string, unknown>, headerAgentId?: string): ListRequest | { error: string } {
  const bad = unsupported(args, LIST_ARGS);
  if (bad) return { error: bad };
  const tagMatch = args.tag_match ?? "any";
  if (tagMatch !== "any" && tagMatch !== "all") return { error: "tag_match must be 'any' or 'all'" };
  return {
    page: positiveInt(args.page, 1, 1_000_000),
    pageSize: positiveInt(args.page_size, 20, 100),
    tags: normalizeTags(args.tags),
    tagMatch,
    memoryType: typeof args.memory_type === "string" && args.memory_type ? args.memory_type : undefined,
    staleDays: args.stale_days === undefined ? undefined : positiveInt(args.stale_days, 1, 100_000),
    agentId: (typeof args.agent_id === "string" && args.agent_id) || headerAgentId || undefined,
    store: storeOf(args.store),
  };
}

function lastAccess(m: StoredMemory): number {
  const at = Number(m.metadata.last_accessed_at);
  return Number.isFinite(at) && at > 0 ? at : m.createdAt;
}

export function listPage(memories: StoredMemory[], req: ListRequest, now: number): string {
  const matching = memories
    .filter((m) => !req.tags.length || hasAllOrAny(m.tags, req.tags, req.tagMatch))
    .filter((m) => req.memoryType === undefined || m.memoryType === req.memoryType)
    .filter((m) => req.staleDays === undefined || lastAccess(m) < now - req.staleDays * 86400)
    .filter((m) => req.agentId === undefined || memoryAgentId(m) === req.agentId || m.tags.includes(`agent:${req.agentId}`));
  const offset = (req.page - 1) * req.pageSize;
  const page = matching.slice(offset, offset + req.pageSize).map((m) => ({
    content: m.content,
    content_hash: m.contentHash,
    tags: m.tags,
    memory_type: m.memoryType,
    metadata: m.metadata,
    created_at: m.createdAt,
    updated_at: m.updatedAt ?? m.createdAt,
    created_at_iso: m.createdAtIso,
    updated_at_iso: m.updatedAtIso ?? m.createdAtIso,
    agent_id: memoryAgentId(m) ?? null,
  }));
  return JSON.stringify(
    {
      memories: page,
      page: req.page,
      page_size: req.pageSize,
      total: matching.length,
      total_pages: Math.ceil(matching.length / req.pageSize),
      has_more: offset + req.pageSize < matching.length,
    },
    null,
    2,
  );
}

export type DeleteRequest =
  | { kind: "hash"; contentHash: string; dryRun: boolean; store: string | null }
  | { kind: "filter"; tags: string[]; tagMatch: "any" | "all"; after?: number; before?: number; dryRun: boolean; store: string | null };

function dateBoundary(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isNaN(ms) ? "invalid" : ms / 1000;
}

export function parseDeleteArgs(args: Record<string, unknown>): DeleteRequest | { error: string } {
  const bad = unsupported(args, DELETE_ARGS);
  if (bad) return { error: bad };
  const tagMatch = args.tag_match ?? "any";
  if (tagMatch !== "any" && tagMatch !== "all") return { error: `Invalid tag_match: ${String(tagMatch)}. Must be 'any' or 'all'` };
  if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") return { error: "dry_run must be true or false" };
  const dryRun = args.dry_run === true;
  const store = storeOf(args.store);
  if (typeof args.content_hash === "string" && args.content_hash.trim()) {
    return { kind: "hash", contentHash: args.content_hash.trim(), dryRun, store };
  }
  const tags = normalizeTags(args.tags);
  const after = dateBoundary(args.after);
  const before = dateBoundary(args.before);
  if (after === "invalid" || before === "invalid") return { error: "Invalid date format. Use YYYY-MM-DD" };
  if (!tags.length && after === undefined && before === undefined) {
    return { error: "At least one filter required (content_hash, tags, before, or after)" };
  }
  return { kind: "filter", tags, tagMatch, after, before, dryRun, store };
}

export function deleteTargets(memories: StoredMemory[], req: Extract<DeleteRequest, { kind: "filter" }>): StoredMemory[] {
  return memories
    .filter((m) => !req.tags.length || hasAllOrAny(m.tags, req.tags, req.tagMatch))
    .filter((m) => req.after === undefined || m.createdAt >= req.after)
    .filter((m) => req.before === undefined || m.createdAt < req.before);
}

export function deleteReply(hashes: string[], dryRun: boolean, single: boolean): string {
  if (!dryRun) {
    const head = single ? "Memory deleted successfully" : `Deleted ${hashes.length} memories matching the filters`;
    return `${head}\n\nDeleted ${hashes.length} memories`;
  }
  const head = single ? `Would delete 1 memory with hash: ${hashes[0]}` : `Found ${hashes.length} memories matching the filters`;
  let text = `${head}\n\nWould delete ${hashes.length} memories`;
  if (hashes.length) {
    text += `\nHashes: ${hashes.slice(0, 5).join(", ")}`;
    if (hashes.length > 5) text += ` ... and ${hashes.length - 5} more`;
  }
  return text;
}

export interface MemoryUpdate {
  memoryType?: string;
  metadataJson?: string;
  tags?: string[];
  updatedAt: number;
  updatedAtIso: string;
}

const RESERVED_UPDATE_KEYS = new Set(["tags", "memory_type", "metadata", "content", "reason", "created_at", "created_at_iso", "updated_at", "updated_at_iso"]);

export function planUpdate(
  current: StoredMemory,
  args: Record<string, unknown>,
  now: number,
): { update: MemoryUpdate; changed: boolean } | { error: string } {
  if (typeof args.content_hash !== "string" || !args.content_hash) return { error: "Error: content_hash is required" };
  const updates = args.updates;
  if (!updates) return { error: "Error: updates dictionary is required" };
  if (typeof updates !== "object" || Array.isArray(updates)) return { error: "Error: updates must be a dictionary" };
  if (args.versioned === true) return { error: "Error: versioned updates are not supported by the current storage backend." };
  const u = updates as Record<string, unknown>;

  const update: MemoryUpdate = { updatedAt: now, updatedAtIso: isoUtc(now) };
  let changed = false;

  if (typeof u.memory_type === "string" && u.memory_type) {
    const type = coerceMemoryType(u.memory_type);
    if (type !== current.memoryType) {
      update.memoryType = type;
      changed = true;
    }
  }
  if ("tags" in u) {
    const tags = normalizeTags(u.tags);
    const same = tags.length === current.tags.length && tags.every((t) => current.tags.includes(t));
    if (!same) {
      update.tags = tags;
      changed = true;
    }
  }

  const extra: Record<string, unknown> = {};
  if (u.metadata && typeof u.metadata === "object" && !Array.isArray(u.metadata)) {
    Object.assign(extra, u.metadata);
  }
  for (const [k, v] of Object.entries(u)) if (!RESERVED_UPDATE_KEYS.has(k)) extra[k] = v;
  delete extra.tags;
  delete extra.type;
  if (Object.keys(extra).length) {
    const merged = { ...current.metadata, ...extra };
    if (JSON.stringify(merged) !== JSON.stringify(current.metadata)) {
      update.metadataJson = pythonJson(merged);
      changed = true;
    }
  }
  return { update, changed };
}

export function storageStats(memories: StoredMemory[], deletedCount: number, documents: string[]): string {
  const count = (key: (m: StoredMemory) => string[]) => {
    const totals = new Map<string, number>();
    for (const m of memories) for (const k of key(m)) totals.set(k, (totals.get(k) ?? 0) + 1);
    return Object.fromEntries([...totals.entries()].sort(([ka, a], [kb, b]) => b - a || ka.localeCompare(kb)));
  };
  const originals = new Set(
    memories.map((m) => (typeof m.metadata.original_hash === "string" ? m.metadata.original_hash : m.contentHash)),
  );
  const times = memories.map((m) => m.createdAtIso).sort();
  const tags = count((m) => m.tags);
  return JSON.stringify(
    {
      memories: originals.size,
      rows: memories.length,
      chunked_rows: memories.filter((m) => m.metadata.total_chunks !== undefined).length,
      deleted_rows: deletedCount,
      by_type: count((m) => [m.memoryType ?? "none"]),
      by_agent: count((m) => [memoryAgentId(m) ?? "unknown"]),
      top_tags: Object.fromEntries(Object.entries(tags).slice(0, 20)),
      distinct_tags: Object.keys(tags).length,
      oldest: times[0] ?? null,
      newest: times.at(-1) ?? null,
      documents,
    },
    null,
    2,
  );
}
