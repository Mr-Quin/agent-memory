import { describe, expect, test } from "bun:test";
import { deleteReply, deleteTargets, listPage, parseDeleteArgs, parseListArgs, planUpdate, storageStats } from "./manage.function";
import type { StoredMemory } from "./search.function";

const NOW = 1795150000;
const memory = (over: Partial<StoredMemory>): StoredMemory => ({
  contentHash: "h",
  vectorId: "h",
  content: "c",
  tags: [],
  memoryType: "note",
  metadata: {},
  createdAt: NOW,
  createdAtIso: "2026-11-20T04:46:40.000000Z",
  ...over,
});

const rows = [
  memory({ contentHash: "a", tags: ["x", "y"], memoryType: "decision", metadata: { agent_id: "agent-a" } }),
  memory({ contentHash: "b", tags: ["x"], createdAt: NOW - 40 * 86400, metadata: { last_accessed_at: NOW - 86400 } }),
  memory({ contentHash: "c", tags: ["y"], createdAt: NOW - 40 * 86400, createdAtIso: "2026-10-11T00:00:00.000000Z" }),
];

describe("memory_list", () => {
  const list = (args: Record<string, unknown>, agent?: string) => {
    const req = parseListArgs(args, agent);
    if ("error" in req) throw new Error(req.error);
    return JSON.parse(listPage(rows, req, NOW));
  };

  test("pages in the Python server's shape", () => {
    const page = list({ page: 2, page_size: 2 });
    expect(page).toMatchObject({ page: 2, page_size: 2, total: 3, total_pages: 2, has_more: false });
    expect(page.memories[0]).toEqual({
      content: "c", content_hash: "c", tags: ["y"], memory_type: "note", metadata: {},
      created_at: NOW - 40 * 86400, updated_at: NOW - 40 * 86400,
      created_at_iso: "2026-10-11T00:00:00.000000Z", updated_at_iso: "2026-10-11T00:00:00.000000Z", agent_id: null,
    });
  });

  test("filters by tags, type, staleness and agent", () => {
    const hashes = (args: Record<string, unknown>, agent?: string) =>
      list(args, agent).memories.map((m: { content_hash: string }) => m.content_hash);
    expect(hashes({ tags: ["x", "y"], tag_match: "all" })).toEqual(["a"]);
    expect(hashes({ memory_type: "decision" })).toEqual(["a"]);
    expect(hashes({ stale_days: 30 })).toEqual(["c"]);
    expect(hashes({}, "agent-a")).toEqual(["a"]);
  });

  test("refuses arguments it does not support", () => {
    expect(parseListArgs({ include_superseded: true })).toEqual({ error: "not supported by this server: include_superseded" });
  });
});

describe("memory_delete", () => {
  test("needs a filter, and a hash wins over the others", () => {
    expect(parseDeleteArgs({})).toEqual({ error: "At least one filter required (content_hash, tags, before, or after)" });
    expect(parseDeleteArgs({ content_hash: "a", tags: "x" })).toMatchObject({ kind: "hash", contentHash: "a" });
    expect(parseDeleteArgs({ tags: "x", dry_run: "yes" })).toEqual({ error: "dry_run must be true or false" });
  });

  test("combines tags and dates with AND", () => {
    const req = parseDeleteArgs({ tags: "x", before: "2026-11-01" });
    if ("error" in req || req.kind !== "filter") throw new Error("expected a filter");
    expect(deleteTargets(rows, req).map((m) => m.contentHash)).toEqual(["b"]);
  });

  test("replies like the Python server", () => {
    expect(deleteReply(["a"], false, true)).toBe("Memory deleted successfully\n\nDeleted 1 memories");
    expect(deleteReply(["a"], true, true)).toBe("Would delete 1 memory with hash: a\n\nWould delete 1 memories\nHashes: a");
    expect(deleteReply(["1", "2", "3", "4", "5", "6"], true, false)).toEndWith("Hashes: 1, 2, 3, 4, 5 ... and 1 more");
  });
});

describe("memory_update", () => {
  const current = memory({ tags: ["x"], memoryType: "note", metadata: { agent_id: "agent-a", n: 1 } });

  test("replaces tags, sets the type and merges metadata", () => {
    const plan = planUpdate(current, { content_hash: "h", updates: { tags: "x,Y", memory_type: "decision", metadata: { n: 2 }, status: "done" } }, NOW);
    expect(plan).toMatchObject({
      changed: true,
      update: { tags: ["x", "y"], memoryType: "decision", metadataJson: '{"agent_id": "agent-a", "n": 2, "status": "done"}' },
    });
  });

  test("reports no change, and refuses what this backend cannot do", () => {
    expect(planUpdate(current, { content_hash: "h", updates: { tags: ["x"] } }, NOW)).toMatchObject({ changed: false });
    expect(planUpdate(current, { content_hash: "h" }, NOW)).toEqual({ error: "Error: updates dictionary is required" });
    expect(planUpdate(current, { content_hash: "h", updates: { content: "x" }, versioned: true }, NOW)).toEqual({
      error: "Error: versioned updates are not supported by the current storage backend.",
    });
  });
});

test("storageStats counts memories, not chunks", () => {
  const chunks = [0, 1].map((i) =>
    memory({ contentHash: `k${i}`, metadata: { original_hash: "orig", chunk_index: i, total_chunks: 2, agent_id: "agent-b" }, tags: ["x"] }),
  );
  const stats = JSON.parse(storageStats([...rows, ...chunks], 4, ["persona"]));
  expect(stats).toMatchObject({
    memories: 4, rows: 5, chunked_rows: 2, deleted_rows: 4, documents: ["persona"],
    by_type: { note: 4, decision: 1 },
    by_agent: { "agent-b": 2, unknown: 2, "agent-a": 1 },
    oldest: "2026-10-11T00:00:00.000000Z",
  });
  expect(Object.keys(stats.top_tags)[0]).toBe("x");
});
