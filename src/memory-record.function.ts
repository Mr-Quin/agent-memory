export const MAX_CONTENT_LENGTH = 800;
const SPLIT_OVERLAP = 50;
const MAX_TAG_LENGTH = 100;
const MAX_TAGS = 50;

const TAXONOMY: Record<string, string[]> = {
  observation: [
    "code_edit", "file_access", "search", "command", "conversation", "conversation_turn",
    "session", "document", "note", "reference", "user_correction", "tool_outcome",
    "preference_signal",
  ],
  decision: ["architecture", "tool_choice", "approach", "configuration"],
  learning: ["insight", "best_practice", "anti_pattern", "gotcha"],
  error: ["bug", "failure", "exception", "timeout", "mistake"],
  pattern: ["recurring_issue", "code_smell", "design_pattern", "workflow"],
  planning: [
    "sprint_goal", "backlog_item", "story_point_estimate", "velocity", "retrospective",
    "standup_note", "acceptance_criteria",
  ],
  ceremony: ["sprint_review", "sprint_planning", "daily_standup", "retrospective_action", "demo_feedback"],
  milestone: ["deliverable", "dependency", "risk", "constraint", "assumption", "deadline"],
  stakeholder: ["requirement", "feedback", "escalation", "approval", "change_request", "status_update"],
  meeting: ["action_item", "attendee_note", "agenda_item", "follow_up", "minutes"],
  research: ["finding", "comparison", "recommendation", "source", "hypothesis"],
  communication: ["email_summary", "chat_summary", "announcement", "request", "response"],
};

const KNOWN_TYPES = new Set(Object.entries(TAXONOMY).flatMap(([base, subs]) => [base, ...subs]));

export function coerceMemoryType(type: string): string {
  return KNOWN_TYPES.has(type) ? type : "observation";
}

export async function contentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeTags(tags: unknown): string[] {
  let list: unknown[];
  if (tags === null || tags === undefined) return [];
  if (typeof tags === "string") {
    const stripped = tags.trim();
    if (!stripped) return [];
    if (stripped.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(stripped);
        list = Array.isArray(parsed) ? parsed.map(String) : [stripped];
      } catch {
        list = [stripped];
      }
    } else if (stripped.includes(",")) {
      list = stripped.split(",").map((t) => t.trim()).filter(Boolean);
    } else {
      list = [stripped];
    }
  } else if (Array.isArray(tags)) {
    list = tags;
  } else {
    return [];
  }

  const out: string[] = [];
  for (const tag of list) {
    if (typeof tag !== "string") continue;
    let t = tag.trim();
    if (!t) continue;
    t = t.replaceAll(",", "-");
    t = [...t].slice(0, MAX_TAG_LENGTH).join("").toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

// Lengths are counted in code points, as Python's len() does, so chunk
// boundaries land where the Python server put them.
export function splitContent(content: string, maxLength = MAX_CONTENT_LENGTH, overlap = SPLIT_OVERLAP): string[] {
  if (!content) return [];
  let remaining = [...content];
  if (remaining.length <= maxLength) return [content];

  const chunks: string[] = [];
  while (remaining.length) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining.join(""));
      break;
    }
    const splitPoint = bestSplitPoint(remaining.slice(0, maxLength).join(""), maxLength);
    const chunk = remaining.slice(0, splitPoint).join("").trimEnd();
    if (!chunk) {
      remaining = [...remaining.slice(splitPoint).join("").trimStart()];
      if (!remaining.length) {
        chunks.push(chunk);
        break;
      }
      continue;
    }
    chunks.push(chunk);

    let nextStart = splitPoint;
    if (splitPoint > overlap) {
      let overlapStart = Math.max(0, splitPoint - overlap);
      if (overlap > 0 && overlapStart > 0) {
        const spacePos = remaining.slice(overlapStart, splitPoint).indexOf(" ");
        if (spacePos !== -1) overlapStart += spacePos + 1;
      }
      nextStart = overlapStart;
    }
    remaining = [...remaining.slice(nextStart).join("").trimStart()];
  }
  return chunks;
}

function bestSplitPoint(window: string, maxLength: number): number {
  const cps = [...window];
  const lastIndexOf = (needle: string[]): number => {
    for (let i = cps.length - needle.length; i >= 0; i--) {
      if (needle.every((c, j) => cps[i + j] === c)) return i;
    }
    return -1;
  };
  let pos = lastIndexOf(["\n", "\n"]);
  if (pos !== -1) return pos + 2;
  pos = lastIndexOf(["\n"]);
  if (pos !== -1) return pos + 1;
  for (let i = cps.length - 1; i >= 0; i--) {
    const c = cps[i] as string;
    if ((c === "." || c === "!" || c === "?") && (i === cps.length - 1 || /\s/u.test(cps[i + 1] as string))) {
      return i + 1;
    }
  }
  pos = lastIndexOf([" "]);
  if (pos !== -1) return pos + 1;
  return maxLength;
}

// Python's json.dumps with default separators, which is how the rows the
// Python server wrote look. Non-ASCII is escaped the same way.
export function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 1e16 ? String(value) : pyFloat(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${pythonJson(k)}: ${pythonJson(v)}`)
    .join(", ")}}`;
}

function pyFloat(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : "-Infinity";
  return String(n);
}

export function isoUtc(epochSeconds: number): string {
  const ms = Math.floor(epochSeconds * 1000);
  const micros = Math.round((epochSeconds - Math.floor(epochSeconds)) * 1e6) % 1e6;
  const base = new Date(ms).toISOString().slice(0, 19);
  return `${base}.${String(micros).padStart(6, "0")}Z`;
}

export interface StoreInput {
  content: string;
  metadata: Record<string, unknown>;
  agentIdArgument?: string;
  agentIdHeader?: string;
  conversationId?: string;
}

export interface MemoryRecord {
  contentHash: string;
  content: string;
  memoryType: string;
  createdAt: number;
  createdAtIso: string;
  metadataJson: string | null;
  tags: string[];
  contentSize: number;
}

export interface BuiltMemories {
  records: MemoryRecord[];
  originalHash: string;
  requestedType: string;
  typeWasExplicit: boolean;
  memoryType: string;
}

export async function buildMemoryRecords(input: StoreInput, now: () => number): Promise<BuiltMemories> {
  const metadata = { ...input.metadata };
  const tags = normalizeTags(metadata.tags);
  const typeWasExplicit = "type" in metadata;
  const requestedType = typeof metadata.type === "string" ? metadata.type : "note";
  const memoryType = coerceMemoryType(requestedType);
  delete metadata.tags;
  delete metadata.type;
  if (input.conversationId) metadata.conversation_id = input.conversationId;

  const metadataAgent =
    metadata.agent_id === null || metadata.agent_id === undefined || typeof metadata.agent_id === "object"
      ? undefined
      : String(metadata.agent_id).trim() || undefined;
  const agentId = input.agentIdArgument || input.agentIdHeader || metadataAgent;
  if (agentId) metadata.agent_id = agentId;

  const originalHash = await contentHash(input.content);
  const pieces = splitContent(input.content);
  const records: MemoryRecord[] = [];
  for (const [index, piece] of pieces.entries()) {
    const hash = pieces.length === 1 ? originalHash : await contentHash(piece);
    const pieceMetadata =
      pieces.length === 1
        ? metadata
        : { ...metadata, chunk_index: index, total_chunks: pieces.length, original_hash: originalHash };
    const createdAt = now();
    records.push({
      contentHash: hash,
      content: piece,
      memoryType,
      createdAt,
      createdAtIso: isoUtc(createdAt),
      metadataJson: Object.keys(pieceMetadata).length ? pythonJson(pieceMetadata) : null,
      tags,
      contentSize: new TextEncoder().encode(piece).length,
    });
  }
  return { records, originalHash, requestedType, typeWasExplicit, memoryType };
}
