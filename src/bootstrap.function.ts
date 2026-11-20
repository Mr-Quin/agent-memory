import type { StoredMemory } from "./search.function";

export const BRIEF_MAX_CHARS = 16_000;
const PERSONA_MAX_CHARS = 8_000;
const ITEM_MAX_CHARS = 400;
const ACTIVE_WINDOW_SECONDS = 30 * 24 * 3600;

const DECISION_TYPES = new Set(["decision", "architecture", "tool_choice", "approach", "configuration"]);
const GOTCHA_TYPES = new Set(["gotcha", "mistake", "anti_pattern"]);

export interface BriefMemory {
  key: string;
  content: string;
  tags: string[];
  memoryType: string | null;
  createdAt: number;
  createdAtIso: string;
  accessCount: number;
}

export interface BriefInput {
  persona: string | null;
  memories: StoredMemory[];
  project?: string;
  now: number;
}

// Entries are clipped well under one chunk's length, so a chunked memory is
// represented by its first chunk.
export function mergeChunkedMemories(memories: StoredMemory[]): BriefMemory[] {
  const groups = new Map<string, StoredMemory[]>();
  for (const m of memories) {
    const original = m.metadata.original_hash;
    const key = typeof original === "string" && m.metadata.total_chunks !== undefined ? original : m.contentHash;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups.entries()].map(([key, parts]) => {
    const ordered = [...parts].sort((a, b) => Number(a.metadata.chunk_index ?? 0) - Number(b.metadata.chunk_index ?? 0));
    const first = ordered[0] as StoredMemory;
    return {
      key,
      content: ordered.length > 1 ? `${first.content} …` : first.content,
      tags: first.tags,
      memoryType: first.memoryType,
      createdAt: first.createdAt,
      createdAtIso: first.createdAtIso,
      accessCount: Math.max(...ordered.map((p) => Number(p.metadata.access_count ?? 0) || 0)),
    };
  });
}

export function projectTag(project: string): string {
  const name = project.trim().toLowerCase().replace(/^proj:/, "");
  return `proj:${name}`;
}

function clip(text: string, max = ITEM_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

const day = (m: BriefMemory) => m.createdAtIso.slice(0, 10);
const newestFirst = (a: BriefMemory, b: BriefMemory) => b.createdAt - a.createdAt || a.key.localeCompare(b.key);
const bullet = (m: BriefMemory) => `- (${day(m)}) ${clip(m.content)}`;

export function activeProjects(memories: BriefMemory[], now: number, limit = 10): string[] {
  const recent = memories.filter((m) => m.createdAt >= now - ACTIVE_WINDOW_SECONDS);
  const pool = recent.length ? recent : memories;
  const stats = new Map<string, { count: number; latest: BriefMemory }>();
  for (const m of pool) {
    for (const tag of m.tags.filter((t) => t.startsWith("proj:"))) {
      const s = stats.get(tag);
      if (!s) stats.set(tag, { count: 1, latest: m });
      else stats.set(tag, { count: s.count + 1, latest: m.createdAt > s.latest.createdAt ? m : s.latest });
    }
  }
  return [...stats.entries()]
    .sort(([ta, a], [tb, b]) => b.count - a.count || b.latest.createdAt - a.latest.createdAt || ta.localeCompare(tb))
    .slice(0, limit)
    .map(([tag, s]) => `- ${tag}: ${s.count} memories, latest ${day(s.latest)}`);
}

interface Section {
  title: string;
  lines: string[];
}

export function buildBrief(input: BriefInput): string {
  const memories = mergeChunkedMemories(input.memories);
  const tag = input.project ? projectTag(input.project) : undefined;
  const inProject = (m: BriefMemory) => !tag || m.tags.includes(tag);
  const shown = new Set<string>();
  const take = (list: BriefMemory[], limit: number) => {
    const picked = list.filter((m) => !shown.has(m.key)).slice(0, limit);
    for (const m of picked) shown.add(m.key);
    return picked.map(bullet);
  };

  const preferences: Section = {
    title: "Owner preferences",
    lines: take(
      memories.filter((m) => m.memoryType === "preference_signal" && m.tags.includes("user:owner")).sort(newestFirst),
      10,
    ),
  };
  const projects: Section = { title: "Active projects", lines: tag ? [] : activeProjects(memories, input.now) };
  const decisions: Section = {
    title: tag ? `Recent decisions in ${tag}` : "Recent decisions",
    lines: take(memories.filter((m) => DECISION_TYPES.has(m.memoryType ?? "") && inProject(m)).sort(newestFirst), 8),
  };
  const gotchas: Section = {
    title: tag ? `Gotchas in ${tag}` : "Gotchas",
    lines: take(
      memories
        .filter((m) => GOTCHA_TYPES.has(m.memoryType ?? "") && inProject(m))
        .sort((a, b) => b.accessCount - a.accessCount || newestFirst(a, b)),
      8,
    ),
  };
  const projectNotes: Section = {
    title: `Other notes on ${tag}`,
    lines: tag ? take(memories.filter(inProject).sort(newestFirst), 8) : [],
  };

  const persona = input.persona?.trim()
    ? clipBlock(input.persona.trim(), PERSONA_MAX_CHARS)
    : "No persona is stored on this server.";
  const head = [
    "# Bootstrap",
    "",
    `Generated ${new Date(input.now * 1000).toISOString().slice(0, 10)} from ${memories.length} memories${tag ? `, narrowed to ${tag}` : ""}.`,
    "",
    persona,
  ].join("\n");
  const foot = [
    "## Using memory",
    "",
    "- Entries above are clipped. Use memory_search for the full text and for anything not listed.",
    "- Save what lands (a preference, a decision and its reason, a trap) with memory_store, one fact per memory, tagged with proj:<repo> and a type.",
  ].join("\n");

  // Lowest priority last: trimming takes items from the end of the list first.
  const sections = [preferences, projects, decisions, projectNotes, gotchas];
  const render = () =>
    [
      head,
      ...sections.filter((s) => s.lines.length).map((s) => `## ${s.title}\n\n${s.lines.join("\n")}`),
      foot,
    ].join("\n\n");

  let brief = render();
  while (brief.length > BRIEF_MAX_CHARS) {
    const victim = [...sections].reverse().find((s) => s.lines.length);
    if (!victim) break;
    victim.lines.pop();
    brief = render();
  }
  return brief.length > BRIEF_MAX_CHARS ? `${brief.slice(0, BRIEF_MAX_CHARS - 1)}…` : brief;
}

function clipBlock(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n\n[persona clipped at ${max} characters]`;
}
