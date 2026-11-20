import { describe, expect, test } from "bun:test";
import { activeProjects, BRIEF_MAX_CHARS, buildBrief, mergeChunkedMemories, projectTag } from "./bootstrap.function";
import type { StoredMemory } from "./search.function";

const NOW = 1795150000;
let seq = 0;
const memory = (over: Partial<StoredMemory>): StoredMemory => {
  seq += 1;
  return {
    contentHash: `h${seq}`,
    vectorId: `h${seq}`,
    content: `memory ${seq}`,
    tags: [],
    memoryType: "note",
    metadata: {},
    createdAt: NOW - seq * 3600,
    createdAtIso: new Date((NOW - seq * 3600) * 1000).toISOString(),
    ...over,
  };
};

describe("mergeChunkedMemories", () => {
  test("represents a chunked memory by its first chunk", () => {
    const meta = (i: number) => ({ original_hash: "orig", chunk_index: i, total_chunks: 2, access_count: i + 1 });
    const merged = mergeChunkedMemories([
      memory({ content: "the second half", metadata: meta(1) }),
      memory({ content: "The first half and the second", metadata: meta(0) }),
      memory({ content: "alone" }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ key: "orig", content: "The first half and the second …", accessCount: 2 });
  });
});

test("projectTag accepts a bare name or a tag", () => {
  expect(projectTag("Agent-Memory")).toBe("proj:agent-memory");
  expect(projectTag("proj:x")).toBe("proj:x");
});

test("activeProjects ranks recent project tags by count", () => {
  const merged = mergeChunkedMemories([
    memory({ tags: ["proj:a"] }),
    memory({ tags: ["proj:b"] }),
    memory({ tags: ["proj:b", "other"] }),
    memory({ tags: ["proj:old"], createdAt: NOW - 90 * 24 * 3600 }),
  ]);
  expect(activeProjects(merged, NOW)).toEqual([
    expect.stringMatching(/^- proj:b: 2 memories, latest /),
    expect.stringMatching(/^- proj:a: 1 memories, latest /),
  ]);
});

describe("buildBrief", () => {
  const corpus = [
    memory({ content: "Owner wants plain prose.", memoryType: "preference_signal", tags: ["user:owner"] }),
    memory({ content: "Someone else's preference.", memoryType: "preference_signal", tags: ["user:other"] }),
    memory({ content: "Chose D1 over KV.", memoryType: "decision", tags: ["proj:x"] }),
    memory({ content: "Chose Bun.", memoryType: "decision", tags: ["proj:y"] }),
    memory({ content: "Rarely hit trap.", memoryType: "gotcha", tags: ["proj:x"] }),
    memory({ content: "Often hit trap.", memoryType: "gotcha", tags: ["proj:x"], metadata: { access_count: 9 } }),
    memory({ content: "How deploys work in x.", memoryType: "workflow", tags: ["proj:x"] }),
  ];

  test("starts with the persona and lists each section", () => {
    const brief = buildBrief({ persona: "## Who you are\n\nYou are Ada.", memories: corpus, now: NOW });
    expect(brief).toStartWith("# Bootstrap\n\nGenerated 2026-11-20 from 7 memories.\n\n## Who you are\n\nYou are Ada.");
    expect(brief).toContain("## Owner preferences\n\n- (");
    expect(brief).toContain("Owner wants plain prose.");
    expect(brief).not.toContain("Someone else's preference.");
    expect(brief).toContain("## Active projects\n\n- proj:x: 4 memories");
    expect(brief).toContain("Chose Bun.");
    expect(brief.indexOf("Often hit trap.")).toBeLessThan(brief.indexOf("Rarely hit trap."));
    expect(brief).toEndWith("tagged with proj:<repo> and a type.");
  });

  test("narrows to one project", () => {
    const brief = buildBrief({ persona: null, memories: corpus, project: "x", now: NOW });
    expect(brief).toContain("narrowed to proj:x");
    expect(brief).toContain("No persona is stored on this server.");
    expect(brief).toContain("## Recent decisions in proj:x");
    expect(brief).not.toContain("Chose Bun.");
    expect(brief).not.toContain("## Active projects");
    expect(brief).toContain("## Other notes on proj:x\n\n- (");
    expect(brief).toContain("How deploys work in x.");
  });

  test("is the same for the same input", () => {
    const a = buildBrief({ persona: "p", memories: corpus, now: NOW });
    expect(buildBrief({ persona: "p", memories: [...corpus].reverse(), now: NOW })).toBe(a);
  });

  test("stays within its bound by dropping the lowest-priority entries first", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      memory({ content: `${"long text ".repeat(60)}${i}`, memoryType: i % 2 ? "gotcha" : "decision", tags: ["proj:z"] }),
    );
    const prefs = [memory({ content: "Keep me.", memoryType: "preference_signal", tags: ["user:owner"] })];
    const brief = buildBrief({ persona: "x".repeat(7000), memories: [...prefs, ...many], now: NOW });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(brief).toContain("Keep me.");
    expect(brief).toContain("## Using memory");
  });
});
