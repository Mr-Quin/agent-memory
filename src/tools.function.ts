import { buildMemoryRecords, type MemoryRecord } from "./memory-record.function";
import {
  type AccessUpdate,
  accessUpdate,
  applyFilters,
  formatSearchResponse,
  parseSearchArgs,
  retrieveStage,
  type SearchRequest,
  semanticFetchSizes,
  type StoredMemory,
} from "./search.function";

export interface MemoryStore {
  embed(texts: string[]): Promise<number[][]>;
  activeHashes(hashes: string[]): Promise<Set<string>>;
  insert(records: MemoryRecord[], embeddings: number[][], store: string): Promise<void>;
  nearest(vector: number[], topK: number): Promise<string[]>;
  byVectorIds(ids: string[], store: string | null): Promise<StoredMemory[]>;
  byHash(hash: string, store: string | null): Promise<StoredMemory | null>;
  containing(text: string, store: string | null): Promise<StoredMemory[]>;
  recent(store: string | null): Promise<StoredMemory[]>;
  recordAccess(updates: AccessUpdate[]): Promise<void>;
}

export interface CallContext {
  store: MemoryStore;
  agentIdHeader?: string;
  now: () => number;
  trackAccess: boolean;
  defer: (work: Promise<unknown>) => void;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const TAGS_SCHEMA = {
  oneOf: [
    { type: "array", items: { type: "string" }, description: "Tags as an array of strings" },
    { type: "string", description: "Tags as comma-separated string" },
  ],
};

export const TOOLS = [
  {
    name: "memory_store",
    description: `Store new information with optional tags.

Accepts two tag formats in metadata:
- Array: ["tag1", "tag2"]
- String: "tag1,tag2"

Use \`conversation_id\` to keep incremental notes from the same conversation together.

Example:
{
    "content": "Memory content",
    "metadata": {
        "tags": "important,reference",
        "type": "note"
    }
}`,
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The memory content to store, such as a fact, note, or piece of information.",
        },
        conversation_id: {
          type: "string",
          description: "Optional conversation identifier, kept in metadata.",
        },
        agent_id: {
          type: "string",
          description: "Optional authoring agent id. Falls back to the X-Agent-ID header. Stored in metadata.",
        },
        metadata: {
          type: "object",
          description: "Optional metadata about the memory, including tags and type.",
          properties: {
            tags: { ...TAGS_SCHEMA, description: "Tags to categorize the memory." },
            type: {
              type: "string",
              description:
                "Optional memory type. Base types: observation, decision, learning, error, pattern, planning, ceremony, milestone, stakeholder, meeting, research, communication. Subtypes include note, reference, preference_signal, gotcha, workflow, insight, bug, action_item, finding. Unknown types are stored as 'observation' with a warning.",
            },
          },
        },
        store: {
          type: "string",
          description: "Target store partition (default: 'default').",
        },
      },
      required: ["content"],
    },
    annotations: { destructiveHint: false },
  },
  {
    name: "memory_search",
    description: `Search memories. Primary tool for finding stored information.

USE THIS WHEN:
- User asks "what do you remember about X", "recall", "find memories"
- Looking for past decisions, preferences, context from previous sessions

MODES:
- semantic (default): Finds conceptually similar content even if exact words differ
- exact: Finds memories containing the exact query string

HASH LOOKUP: provide content_hash instead of query to retrieve one memory by its identifier.

FILTERS: tags (any or all via tag_match), after/before (YYYY-MM-DD), agent_id.

Examples:
{"query": "python async patterns"}
{"query": "API endpoint", "mode": "exact"}
{"query": "architecture decisions", "tags": ["important"], "limit": 5}
{"content_hash": "aa6caea3d060e736c8b412e6b34a1354148ec04527a4bf547cfd4185140573d0"}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text search query" },
        content_hash: { type: "string", minLength: 1, description: "Retrieve one memory by its exact content hash." },
        mode: { type: "string", enum: ["semantic", "exact"], default: "semantic", description: "Search mode" },
        tags: { ...TAGS_SCHEMA, description: "Filter to memories with these tags" },
        tag_match: { type: "string", enum: ["any", "all"], default: "any", description: "Match ANY tag or ALL tags" },
        after: { type: "string", description: "Return memories created after this date (YYYY-MM-DD)" },
        before: { type: "string", description: "Return memories created before this date (YYYY-MM-DD)" },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 100, description: "Maximum results to return" },
        max_response_chars: {
          type: "number",
          description: "Maximum response size in characters. Truncates at memory boundaries. Default: unlimited.",
        },
        agent_id: {
          type: "string",
          description: "Filter to memories authored by this agent. Defaults to the X-Agent-ID header when it is sent.",
        },
        store: { type: "string", description: "Store partition (default: 'default'). Use 'all' for every store." },
      },
    },
    annotations: { readOnlyHint: true },
  },
] as const;

// Workers AI embeds at most 100 texts per call; this keeps a store's chunks within one call.
export const MAX_STORE_CHARS = 50_000;

export class ToolError extends Error {}

export async function callTool(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  if (name === "memory_store") return storeMemory(args, ctx);
  if (name === "memory_search") return searchMemories(args, ctx);
  throw new ToolError(`Unknown tool: ${name}`);
}

async function storeMemory(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const content = args.content;
  if (typeof content !== "string" || !content) return { text: "Content is required", isError: true };
  if (content.length > MAX_STORE_CHARS) {
    return { text: `Content is too long: ${content.length} characters (limit ${MAX_STORE_CHARS})`, isError: true };
  }
  const metadata =
    args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
      ? (args.metadata as Record<string, unknown>)
      : {};
  const store = typeof args.store === "string" && args.store ? args.store : "default";

  const built = await buildMemoryRecords(
    {
      content,
      metadata,
      agentIdArgument: typeof args.agent_id === "string" ? args.agent_id : undefined,
      agentIdHeader: ctx.agentIdHeader,
      conversationId: typeof args.conversation_id === "string" ? args.conversation_id : undefined,
    },
    ctx.now,
  );

  const existing = await ctx.store.activeHashes(built.records.map((r) => r.contentHash));
  const fresh = built.records.filter((r) => !existing.has(r.contentHash));
  if (!fresh.length) {
    return {
      text: `Error storing memory: this content is already stored (hash: ${built.records[0]?.contentHash})`,
      isError: true,
    };
  }
  await ctx.store.insert(fresh, await ctx.store.embed(fresh.map((r) => r.content)), store);

  let message =
    built.records.length === 1
      ? `Memory stored successfully (hash: ${built.originalHash})`
      : `Successfully stored ${built.records.length} memory chunks (original hash: ${built.originalHash})`;
  if (built.typeWasExplicit && built.memoryType !== built.requestedType) {
    message += `\nWarning: requested memory_type '${built.requestedType}' is not in the ontology — stored as '${built.memoryType}'.`;
  }
  return { text: message };
}

async function searchMemories(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const req = parseSearchArgs(args, ctx.agentIdHeader);
  if ("error" in req) return { text: `Error: ${req.error}` };

  let found: StoredMemory[];
  if (req.contentHash) {
    const memory = await ctx.store.byHash(req.contentHash, req.store);
    found = memory ? [memory] : [];
  } else if (req.mode === "exact") {
    found = applyFilters(await ctx.store.containing(req.query ?? "", req.store), req);
  } else if (req.query) {
    found = applyFilters(await semanticCandidates(req, ctx), req);
  } else {
    found = applyFilters(await ctx.store.recent(req.store), req);
  }
  return { text: formatSearchResponse(found, req) };
}

async function semanticCandidates(req: SearchRequest, ctx: CallContext): Promise<StoredMemory[]> {
  const { fetchLimit, topK } = semanticFetchSizes(req);
  const [vector] = await ctx.store.embed([req.query ?? ""]);
  const ids = vector ? await ctx.store.nearest(vector, topK) : [];
  const loaded = await ctx.store.byVectorIds(ids, req.store);
  const byId = new Map(loaded.map((m) => [m.vectorId, m]));
  const vectorOrder = ids.map((id) => byId.get(id)).filter((m): m is StoredMemory => m !== undefined);
  const candidates = retrieveStage(vectorOrder, req, fetchLimit);
  if (ctx.trackAccess && candidates.length) {
    const now = ctx.now();
    ctx.defer(ctx.store.recordAccess(candidates.map((m) => accessUpdate(m, req.query, now))));
  }
  return candidates;
}
