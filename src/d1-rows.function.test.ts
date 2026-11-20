import { expect, test } from "bun:test";
import { groupTags, insertParams, rowToMemory, vectorMetadata } from "./d1-rows.function";
import type { MemoryRecord } from "./memory-record.function";

const record: MemoryRecord = {
  contentHash: "h",
  content: "c",
  memoryType: "gotcha",
  createdAt: 1795150015.5,
  createdAtIso: "2026-11-20T04:46:55.500000Z",
  metadataJson: '{"agent_id": "agent-a"}',
  tags: ["proj:x", "gotcha"],
  contentSize: 1,
};

test("insertParams writes a row the way the Python server did", () => {
  expect(insertParams(record, "default")).toEqual([
    "h", "c", "gotcha", 1795150015.5, "2026-11-20T04:46:55.500000Z", 1795150015.5,
    "2026-11-20T04:46:55.500000Z", '{"agent_id": "agent-a"}', "h", 1, null, "proj:x,gotcha", "default",
  ]);
  expect(insertParams({ ...record, tags: [] }, "default")[11]).toBeNull();
});

test("vectorMetadata matches the Python server's vector metadata", () => {
  expect(vectorMetadata(record)).toEqual({
    content_hash: "h",
    memory_type: "gotcha",
    tags: "proj:x,gotcha",
    created_at: "2026-11-20T04:46:55.500000Z",
  });
});

test("rowToMemory parses metadata and survives bad JSON", () => {
  const row = {
    id: 1, content_hash: "h", content: "c", memory_type: "note", created_at: 1,
    created_at_iso: "i", metadata_json: '{"agent_id":"a"}', vector_id: null,
  };
  expect(rowToMemory(row, ["t"])).toMatchObject({ vectorId: "h", metadata: { agent_id: "a" }, tags: ["t"] });
  expect(rowToMemory({ ...row, metadata_json: "{nope" }, []).metadata).toEqual({});
});

test("groupTags keeps link order per memory", () => {
  const grouped = groupTags([
    { memory_id: 1, name: "b" },
    { memory_id: 2, name: "x" },
    { memory_id: 1, name: "a" },
  ]);
  expect(grouped.get(1)).toEqual(["b", "a"]);
});
