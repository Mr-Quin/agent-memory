import { describe, expect, test } from "bun:test";
import { FakeStore, fakeContext } from "./fake-store.testing";
import fixtures from "./split-fixtures.json";
import { callTool, MAX_STORE_CHARS } from "./tools.function";

async function seed(store: FakeStore) {
  await callTool(
    "memory_store",
    { content: "The build cache lives on the shared runner.", metadata: { tags: "proj:build", type: "reference" } },
    fakeContext(store, "agent-a"),
  );
  await callTool(
    "memory_store",
    { content: "The backup job runs on host number nine.", metadata: { tags: ["proj:infra", "backups"], type: "reference" } },
    fakeContext(store, "agent-b"),
  );
}

describe("memory_store", () => {
  test("answers with the hash the way the Python server did", async () => {
    const store = new FakeStore();
    const result = await callTool("memory_store", { content: "A fact." }, fakeContext(store));
    expect(result.text).toMatch(/^Memory stored successfully \(hash: [0-9a-f]{64}\)$/);
    expect(result.isError).toBeUndefined();
  });

  test("refuses empty content and duplicates as errors", async () => {
    const store = new FakeStore();
    expect((await callTool("memory_store", { content: "" }, fakeContext(store))).isError).toBe(true);
    await callTool("memory_store", { content: "Same." }, fakeContext(store));
    const again = await callTool("memory_store", { content: "  same. " }, fakeContext(store));
    expect(again.isError).toBe(true);
    expect(store.rows).toHaveLength(1);
  });

  test("stores long content as chunks, embedded in one call", async () => {
    const store = new FakeStore();
    const result = await callTool("memory_store", { content: fixtures[0]?.input }, fakeContext(store, "agent-a"));
    expect(result.text).toMatch(/^Successfully stored 2 memory chunks \(original hash: [0-9a-f]{64}\)$/);
    expect(store.embedded).toEqual(fixtures[0]?.chunks ?? []);
    expect(store.embedCalls).toBe(1);
  });

  test("refuses content over the size limit before embedding anything", async () => {
    const store = new FakeStore();
    const result = await callTool("memory_store", { content: "x".repeat(MAX_STORE_CHARS + 1) }, fakeContext(store));
    expect(result).toEqual({ text: `Content is too long: ${MAX_STORE_CHARS + 1} characters (limit ${MAX_STORE_CHARS})`, isError: true });
    expect(store.embedCalls).toBe(0);
  });

  test("warns when an explicit type is coerced", async () => {
    const store = new FakeStore();
    const result = await callTool("memory_store", { content: "x", metadata: { type: "musing" } }, fakeContext(store));
    expect(result.text).toContain("requested memory_type 'musing' is not in the ontology");
    expect(store.rows[0]?.memoryType).toBe("observation");
  });
});

describe("memory_search", () => {
  test("without X-Agent-ID it sees every agent's memories", async () => {
    const store = new FakeStore();
    await seed(store);
    const result = await callTool("memory_search", { query: "build cache", limit: 5 }, fakeContext(store));
    expect(result.text).toStartWith("Found 2 memories (mode: semantic) for query: 'build cache'\n\n1. The build cache");
    expect(result.text).toContain("   Created: 2026-11-20T");
    expect(result.text).toContain(" [proj:build]");
  });

  test("with X-Agent-ID it narrows to that agent", async () => {
    const store = new FakeStore();
    await seed(store);
    const result = await callTool("memory_search", { query: "build cache" }, fakeContext(store, "agent-b"));
    expect(result.text).toStartWith("Found 1 memories");
    expect(result.text).toContain("backup job");
    expect(result.text).not.toContain("build cache lives");
  });

  test("finds a rare agent's memory at limit 1 when many others rank first", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 40; i++) {
      await callTool("memory_store", { content: `Runner note number ${i} about caches.` }, fakeContext(store, "agent-a"));
    }
    await callTool("memory_store", { content: "The backup job runs on host number nine." }, fakeContext(store, "agent-b"));
    const result = await callTool("memory_search", { query: "runner caches", agent_id: "agent-b", limit: 1 }, fakeContext(store));
    expect(result.text).toStartWith("Found 1 memories");
    expect(result.text).toContain("backup job");
  });

  test("filters by tags and records access on what it retrieved", async () => {
    const store = new FakeStore();
    await seed(store);
    const ctx = fakeContext(store);
    const result = await callTool("memory_search", { query: "anything", tags: ["backups"] }, ctx);
    expect(result.text).toStartWith("Found 1 memories");
    await Promise.all(ctx.deferred);
    expect(store.access).toHaveLength(1);
    expect(store.access[0]?.accessQueries.at(-1)?.query).toBe("anything");
  });

  test("bounds the response with max_response_chars", async () => {
    const store = new FakeStore();
    await seed(store);
    const result = await callTool("memory_search", { query: "build", max_response_chars: 400 }, fakeContext(store));
    expect(result.text.length).toBeLessThanOrEqual(400);
    expect(result.text).toContain("=== Memory 1 ===");
    expect(result.text).toContain("[!] RESPONSE TRUNCATED: Showing 1 of 2 results.");
  });

  test("looks up by hash, exact text, and tags alone", async () => {
    const store = new FakeStore();
    await seed(store);
    const hash = store.rows[0]?.contentHash ?? "";
    expect((await callTool("memory_search", { content_hash: hash }, fakeContext(store))).text).toStartWith(
      `Found 1 memories (mode: hash) for content hash: '${hash}'`,
    );
    expect((await callTool("memory_search", { query: "NUMBER NINE", mode: "exact" }, fakeContext(store))).text).toContain(
      "backup job",
    );
    expect((await callTool("memory_search", { tags: "proj:build" }, fakeContext(store))).text).toStartWith("Found 1 memories");
  });

  test("says so when nothing matches, and when an argument is not supported", async () => {
    const store = new FakeStore();
    expect((await callTool("memory_search", { query: "x" }, fakeContext(store))).text).toBe("No memories found for query: 'x'");
    expect((await callTool("memory_search", { query: "x", time_expr: "last week" }, fakeContext(store))).text).toBe(
      "Error: not supported by this server: time_expr",
    );
  });
});

describe("agent_bootstrap and the management tools", () => {
  test("bootstrap returns the brief with the stored persona", async () => {
    const store = new FakeStore();
    store.documents.set("persona", "## Who you are\n\nYou are Ada.");
    await seed(store);
    const result = await callTool("agent_bootstrap", {}, fakeContext(store));
    expect(result.text).toStartWith("# Bootstrap\n\nGenerated ");
    expect(result.text).toContain("You are Ada.");
    expect(result.text).toContain("## Active projects");
  });

  test("delete removes a memory from search, and update changes its tags", async () => {
    const store = new FakeStore();
    await seed(store);
    const [first, second] = store.rows.map((r) => r.contentHash);
    expect((await callTool("memory_update", { content_hash: first, updates: { tags: "proj:build,keep" } }, fakeContext(store))).text).toBe(
      "Successfully updated memory metadata. Memory metadata updated successfully",
    );
    expect(store.rows[0]?.tags).toEqual(["proj:build", "keep"]);
    expect((await callTool("memory_delete", { content_hash: second }, fakeContext(store))).text).toStartWith("Memory deleted successfully");
    expect((await callTool("memory_search", { query: "backup job" }, fakeContext(store))).text).not.toContain("backup job runs");
    expect((await callTool("memory_update", { content_hash: second, updates: { tags: "x" } }, fakeContext(store))).text).toBe(
      "Failed to update memory metadata: Memory not found",
    );
  });

  test("a dry run deletes nothing", async () => {
    const store = new FakeStore();
    await seed(store);
    const result = await callTool("memory_delete", { tags: "proj:build", dry_run: true }, fakeContext(store));
    expect(result.text).toStartWith("Found 1 memories matching the filters\n\nWould delete 1 memories");
    expect(store.rows).toHaveLength(2);
  });
});
