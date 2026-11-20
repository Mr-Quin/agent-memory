import { normalizeTags } from "./memory-record.function";

export interface StoredMemory {
  contentHash: string;
  vectorId: string;
  content: string;
  tags: string[];
  memoryType: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  createdAtIso: string;
  updatedAt?: number;
  updatedAtIso?: string;
}

export interface SearchRequest {
  query?: string;
  contentHash?: string;
  mode: "semantic" | "exact";
  tags: string[];
  tagMatch: "any" | "all";
  limit: number;
  maxResponseChars: number;
  agentId?: string;
  after?: number;
  before?: number;
  store: string | null;
}

const SUPPORTED = new Set([
  "query", "content_hash", "mode", "tags", "tag_match", "limit", "max_response_chars",
  "agent_id", "after", "before", "store",
]);
const HASH_LOOKUP_ARGS = new Set(["content_hash", "store", "limit", "max_response_chars"]);

export function parseSearchArgs(args: Record<string, unknown>, headerAgentId?: string): SearchRequest | { error: string } {
  const unsupported = Object.keys(args).filter((k) => !SUPPORTED.has(k) && args[k] !== undefined && args[k] !== null);
  if (unsupported.length) return { error: `not supported by this server: ${unsupported.sort().join(", ")}` };

  const store = args.store === "all" ? null : args.store === undefined ? "default" : String(args.store);

  if (args.content_hash !== undefined) {
    if ("query" in args) return { error: "query and content_hash are mutually exclusive" };
    if (typeof args.content_hash !== "string" || !args.content_hash.trim()) {
      return { error: "content_hash must be a non-empty string" };
    }
    const extra = Object.keys(args).filter((k) => !HASH_LOOKUP_ARGS.has(k)).sort();
    if (extra.length) return { error: `content_hash cannot be combined with search arguments: ${extra.join(", ")}` };
  }

  const mode = args.mode ?? "semantic";
  if (mode !== "semantic" && mode !== "exact") {
    return { error: `Invalid mode: ${String(mode)}. This server supports 'semantic' and 'exact'` };
  }
  const tagMatch = args.tag_match ?? "any";
  if (tagMatch !== "any" && tagMatch !== "all") return { error: "tag_match must be 'any' or 'all'" };

  const limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limit ?? 10)) || 10));
  const maxResponseChars = Math.trunc(Number(args.max_response_chars ?? 0)) || 0;

  const after = parseBoundary(args.after);
  const before = parseBoundary(args.before);
  if (after === "invalid") return { error: `Invalid after date format: ${String(args.after)}. Use YYYY-MM-DD` };
  if (before === "invalid") return { error: `Invalid before date format: ${String(args.before)}. Use YYYY-MM-DD` };

  const query = typeof args.query === "string" && args.query ? args.query : undefined;
  const tags = normalizeTags(args.tags);
  const agentId = (typeof args.agent_id === "string" && args.agent_id) || headerAgentId || undefined;

  if (args.content_hash === undefined) {
    if (mode === "exact" && !query) return { error: "query required for exact mode" };
    if (!query && after === undefined && before === undefined && !tags.length) {
      return { error: "At least one filter required (query, time_expr, after, before, or tags)" };
    }
  }

  return {
    query,
    contentHash: typeof args.content_hash === "string" ? args.content_hash.trim() : undefined,
    mode,
    tags,
    tagMatch,
    limit,
    maxResponseChars,
    agentId,
    after,
    before,
    store,
  };
}

function parseBoundary(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "invalid" : ms / 1000;
}

export function hasAllOrAny(memoryTags: string[], wanted: string[], match: "any" | "all"): boolean {
  return match === "all" ? wanted.every((t) => memoryTags.includes(t)) : wanted.some((t) => memoryTags.includes(t));
}

export function memoryAgentId(memory: StoredMemory): string | undefined {
  const value = memory.metadata.agent_id;
  return typeof value === "string" ? value : undefined;
}

export function applyFilters(memories: StoredMemory[], req: SearchRequest): StoredMemory[] {
  return memories
    .filter((m) => req.after === undefined || (m.createdAt && m.createdAt >= req.after))
    .filter((m) => req.before === undefined || (m.createdAt && m.createdAt <= req.before))
    .filter((m) => !req.tags.length || hasAllOrAny(m.tags, req.tags, req.tagMatch))
    .filter((m) => req.agentId === undefined || memoryAgentId(m) === req.agentId || m.tags.includes(`agent:${req.agentId}`))
    .slice(0, req.limit);
}

export function semanticFetchSizes(req: SearchRequest): { fetchLimit: number; topK: number } {
  const fetchLimit = req.agentId !== undefined ? req.limit * 5 : req.limit;
  const wanted = req.tags.length ? fetchLimit * 3 : fetchLimit;
  return { fetchLimit, topK: Math.min(wanted, 100) };
}

// The retrieve step keeps any-tag matches only and stops at fetchLimit,
// before the stricter filters run, as the Python server's retrieve() does.
export function retrieveStage(candidates: StoredMemory[], req: SearchRequest, fetchLimit: number): StoredMemory[] {
  if (!req.tags.length) return candidates;
  return candidates.filter((m) => req.tags.some((t) => m.tags.includes(t))).slice(0, fetchLimit);
}

export interface AccessUpdate {
  contentHash: string;
  accessCount: number;
  lastAccessedAt: number;
  accessQueries: { query: string; timestamp: number }[];
}

export function accessUpdate(memory: StoredMemory, query: string | undefined, now: number): AccessUpdate {
  const previous = Number(memory.metadata.access_count ?? 0) || 0;
  const queries = Array.isArray(memory.metadata.access_queries)
    ? (memory.metadata.access_queries as { query: string; timestamp: number }[])
    : [];
  return {
    contentHash: memory.contentHash,
    accessCount: previous + 1,
    lastAccessedAt: now,
    accessQueries: query ? [...queries, { query, timestamp: now }].slice(-10) : queries,
  };
}

function header(req: SearchRequest, total: number, mode: string): string {
  let text = `Found ${total} memories (mode: ${mode})`;
  if (req.contentHash) text += ` for content hash: '${req.contentHash}'`;
  else if (req.query) text += ` for query: '${req.query}'`;
  return text;
}

function emptyText(req: SearchRequest): string {
  let text = "No memories found";
  if (req.contentHash) text += ` for content hash: '${req.contentHash}'`;
  else if (req.query) text += ` for query: '${req.query}'`;
  return text;
}

export function formatSearchResponse(memories: StoredMemory[], req: SearchRequest): string {
  const mode = req.contentHash ? "hash" : req.mode;
  if (!memories.length) {
    const text = emptyText(req);
    return req.maxResponseChars > 0 ? boundedResponse([], req.maxResponseChars, text) : text;
  }
  if (req.maxResponseChars > 0) {
    return boundedResponse(memories, req.maxResponseChars, `${header(req, memories.length, mode)}\n\n`);
  }
  const blocks = memories.map((m, i) => {
    const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
    return `${i + 1}. ${m.content}\n   Hash: ${m.contentHash}\n   Created: ${m.createdAtIso || String(m.createdAt)}${tags}`;
  });
  return `${header(req, memories.length, mode)}\n\n${blocks.join("\n\n")}`;
}

function recordBlock(m: StoredMemory, index: number): string {
  const lines = [`=== Memory ${index} ===`];
  const created = m.createdAtIso || String(m.createdAt);
  if (created) lines.push(`Timestamp: ${created}`);
  lines.push(`Content: ${m.content}`, `Hash: ${m.contentHash}`);
  if (m.tags.length) lines.push(`Tags: ${m.tags.join(", ")}`);
  lines.push("---");
  return lines.join("\n");
}

export function boundedResponse(memories: StoredMemory[], maxChars: number, head: string): string {
  if (maxChars > 0 && maxChars < head.length) return head.slice(0, maxChars);
  const blocks = memories.map((m, i) => recordBlock(m, i + 1));
  let bodyChars = blocks.reduce((n, b) => n + b.length, 0) + Math.max(0, blocks.length - 1);
  for (let shown = blocks.length; shown >= 0; shown--) {
    const notice =
      shown < blocks.length
        ? `[!] RESPONSE TRUNCATED: Showing ${shown} of ${blocks.length} results.\n` +
          `${blocks.length - shown} result(s) omitted. Use a narrower query or hash-based retrieval.\n\n`
        : "";
    if (head.length + notice.length + bodyChars <= maxChars) {
      return head + notice + blocks.slice(0, shown).join("\n");
    }
    if (shown) bodyChars -= (blocks[shown - 1]?.length ?? 0) + (shown > 1 ? 1 : 0);
  }
  return head.slice(0, maxChars);
}
