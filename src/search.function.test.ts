import { describe, expect, test } from "bun:test";
import {
  accessUpdate,
  applyFilters,
  boundedResponse,
  parseSearchArgs,
  type SearchRequest,
  semanticFetchSizes,
  type StoredMemory,
} from "./search.function";

const memory = (over: Partial<StoredMemory>): StoredMemory => ({
  contentHash: "h",
  vectorId: "h",
  content: "c",
  tags: [],
  memoryType: "note",
  metadata: {},
  createdAt: 1795150000,
  createdAtIso: "2026-11-20T04:46:40.000000Z",
  ...over,
});

const req = (args: Record<string, unknown>, agent?: string) => parseSearchArgs(args, agent) as SearchRequest;

describe("parseSearchArgs", () => {
  test("defaults to semantic, limit 10, the default store, and the header agent", () => {
    expect(req({ query: "q" }, "agent-a")).toMatchObject({
      mode: "semantic", limit: 10, store: "default", agentId: "agent-a", tagMatch: "any",
    });
    expect(req({ query: "q", store: "all" }).store).toBeNull();
    expect(req({ query: "q", agent_id: "other" }, "agent-a").agentId).toBe("other");
  });

  test("rejects what the Python server rejected", () => {
    expect(parseSearchArgs({})).toEqual({ error: "At least one filter required (query, time_expr, after, before, or tags)" });
    expect(parseSearchArgs({ query: "q", content_hash: "h" })).toEqual({ error: "query and content_hash are mutually exclusive" });
    expect(parseSearchArgs({ content_hash: "h", tags: "x" })).toEqual({
      error: "content_hash cannot be combined with search arguments: tags",
    });
    expect(parseSearchArgs({ mode: "exact" })).toEqual({ error: "query required for exact mode" });
    expect(parseSearchArgs({ query: "q", after: "yesterday" })).toHaveProperty("error");
  });
});

describe("applyFilters", () => {
  const rows = [
    memory({ contentHash: "a", tags: ["x", "y"], metadata: { agent_id: "agent-a" }, createdAt: 1794000000 }),
    memory({ contentHash: "b", tags: ["x", "agent:agent-b"], createdAt: 1795200000 }),
    memory({ contentHash: "c", tags: ["y"], metadata: { agent_id: "agent-c" } }),
  ];
  const hashes = (r: StoredMemory[]) => r.map((m) => m.contentHash);

  test("matches agent by metadata or by an agent: tag", () => {
    expect(hashes(applyFilters(rows, req({ query: "q" }, "agent-a")))).toEqual(["a"]);
    expect(hashes(applyFilters(rows, req({ query: "q" }, "agent-b")))).toEqual(["b"]);
  });

  test("tag_match any and all, dates, and the limit", () => {
    expect(hashes(applyFilters(rows, req({ tags: "x,y" })))).toEqual(["a", "b", "c"]);
    expect(hashes(applyFilters(rows, req({ tags: "x,y", tag_match: "all" })))).toEqual(["a"]);
    expect(hashes(applyFilters(rows, req({ after: "2026-11-15" })))).toEqual(["b", "c"]);
    expect(hashes(applyFilters(rows, req({ tags: "x,y", limit: 1 })))).toEqual(["a"]);
  });
});

test("semanticFetchSizes takes Vectorize's maximum whenever a filter is set", () => {
  expect(semanticFetchSizes(req({ query: "q", limit: 3 }))).toEqual({ fetchLimit: 3, topK: 3 });
  expect(semanticFetchSizes(req({ query: "q", limit: 1 }, "a"))).toEqual({ fetchLimit: 100, topK: 100 });
  expect(semanticFetchSizes(req({ query: "q", limit: 1, tags: "x" }))).toEqual({ fetchLimit: 100, topK: 100 });
  expect(semanticFetchSizes(req({ query: "q", limit: 1, after: "2026-11-01" }))).toEqual({ fetchLimit: 100, topK: 100 });
  expect(semanticFetchSizes(req({ query: "q", limit: 1, before: "2026-11-01" }))).toEqual({ fetchLimit: 100, topK: 100 });
});

test("accessUpdate counts and keeps the last ten queries", () => {
  const queries = Array.from({ length: 10 }, (_, i) => ({ query: `q${i}`, timestamp: i }));
  const update = accessUpdate(memory({ metadata: { access_count: 4, access_queries: queries } }), "new", 99);
  expect(update.accessCount).toBe(5);
  expect(update.accessQueries).toHaveLength(10);
  expect(update.accessQueries.at(-1)).toEqual({ query: "new", timestamp: 99 });
});

test("boundedResponse returns only the head when even that does not fit", () => {
  expect(boundedResponse([memory({})], 5, "Found 1 memories")).toBe("Found");
});
