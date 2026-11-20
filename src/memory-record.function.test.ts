import { describe, expect, test } from "bun:test";
import fixtures from "./split-fixtures.json";
import {
  buildMemoryRecords,
  coerceMemoryType,
  contentHash,
  isoUtc,
  normalizeTags,
  pythonJson,
  splitContent,
} from "./memory-record.function";

describe("contentHash", () => {
  test("is sha256 of the trimmed, lowercased content, as the Python server computed it", async () => {
    const content =
      "Gotcha: the staging database rejects connections from outside the VPN, so integration tests run from a laptop fail with a timeout. Source: a debugging session, 2026-11-19.";
    expect(await contentHash(content)).toBe("dad59eb65da5747c039d6d3fbca6e910db80784416535043653861e7ea22c1ad");
  });

  test("ignores case and surrounding whitespace", async () => {
    expect(await contentHash("  Hello World \n")).toBe(await contentHash("hello world"));
  });
});

describe("normalizeTags", () => {
  test("accepts a comma string, an array, or a JSON array string", () => {
    expect(normalizeTags("proj:a, Gotcha ,")).toEqual(["proj:a", "gotcha"]);
    expect(normalizeTags(["A", "a", " b "])).toEqual(["a", "b"]);
    expect(normalizeTags('["x","y"]')).toEqual(["x", "y"]);
  });

  test("replaces commas inside array tags and drops non-strings", () => {
    expect(normalizeTags(["a,b", 3, ""])).toEqual(["a-b"]);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags({})).toEqual([]);
  });
});

describe("coerceMemoryType", () => {
  test("keeps base types and subtypes, files unknown ones as observation", () => {
    expect(coerceMemoryType("gotcha")).toBe("gotcha");
    expect(coerceMemoryType("workflow")).toBe("workflow");
    expect(coerceMemoryType("preference_signal")).toBe("preference_signal");
    expect(coerceMemoryType("decision")).toBe("decision");
    expect(coerceMemoryType("musing")).toBe("observation");
  });
});

describe("splitContent", () => {
  test.each(fixtures.map((f, i) => [i, f] as const))("matches the Python splitter on case %i", (_i, fixture) => {
    expect(splitContent(fixture.input)).toEqual(fixture.chunks);
  });
});

describe("pythonJson", () => {
  test("uses Python's separators and escapes non-ASCII", () => {
    expect(pythonJson({ agent_id: "agent-b", n: 2, f: 1795149072.9166443, q: ["é"] })).toBe(
      '{"agent_id": "agent-b", "n": 2, "f": 1795149072.9166443, "q": ["\\u00e9"]}',
    );
  });
});

describe("isoUtc", () => {
  test("writes microseconds and a Z, like the stored rows", () => {
    expect(isoUtc(1795150015.8936274)).toBe("2026-11-20T04:46:55.893627Z");
  });
});

describe("buildMemoryRecords", () => {
  const clock = () => 1795150015.5;

  test("moves tags and type out of metadata and attributes the header agent", async () => {
    const built = await buildMemoryRecords(
      { content: "A fact.", metadata: { tags: "proj:x,gotcha", type: "gotcha", source: "s" }, agentIdHeader: "agent-a" },
      clock,
    );
    expect(built.records).toHaveLength(1);
    const [record] = built.records;
    expect(record?.tags).toEqual(["proj:x", "gotcha"]);
    expect(record?.memoryType).toBe("gotcha");
    expect(record?.metadataJson).toBe('{"source": "s", "agent_id": "agent-a"}');
    expect(record?.contentHash).toBe(built.originalHash);
  });

  test("prefers the agent_id argument, then the header, then metadata", async () => {
    const meta = { agent_id: "from-meta" };
    const arg = await buildMemoryRecords({ content: "x", metadata: meta, agentIdArgument: "arg", agentIdHeader: "hdr" }, clock);
    const hdr = await buildMemoryRecords({ content: "x", metadata: meta, agentIdHeader: "hdr" }, clock);
    const own = await buildMemoryRecords({ content: "x", metadata: meta }, clock);
    expect(arg.records[0]?.metadataJson).toBe('{"agent_id": "arg"}');
    expect(hdr.records[0]?.metadataJson).toBe('{"agent_id": "hdr"}');
    expect(own.records[0]?.metadataJson).toBe('{"agent_id": "from-meta"}');
  });

  test("defaults to note and leaves metadata null when nothing is left", async () => {
    const built = await buildMemoryRecords({ content: "x", metadata: {} }, clock);
    expect(built.records[0]?.memoryType).toBe("note");
    expect(built.records[0]?.metadataJson).toBeNull();
    expect(built.typeWasExplicit).toBe(false);
  });

  test("splits long content into chunks that carry the original hash", async () => {
    const content = fixtures[0]?.input ?? "";
    const built = await buildMemoryRecords({ content, metadata: { type: "workflow" }, agentIdHeader: "agent-a" }, clock);
    expect(built.records).toHaveLength(2);
    expect(built.records[1]?.metadataJson).toBe(
      `{"agent_id": "agent-a", "chunk_index": 1, "total_chunks": 2, "original_hash": "${built.originalHash}"}`,
    );
    expect(built.records[0]?.contentHash).toBe(await contentHash(built.records[0]?.content ?? ""));
  });
});
