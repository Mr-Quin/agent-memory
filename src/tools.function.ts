import { buildBrief } from "./bootstrap.function";
import {
  deleteReply,
  deleteTargets,
  listPage,
  type MemoryUpdate,
  parseDeleteArgs,
  parseListArgs,
  planUpdate,
  storageStats,
} from "./manage.function";
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
  softDelete(memories: StoredMemory[], now: number): Promise<void>;
  update(contentHash: string, update: MemoryUpdate): Promise<void>;
  deletedCount(): Promise<number>;
  document(name: string): Promise<string | null>;
  documentNames(): Promise<string[]>;
}

export const PERSONA_DOCUMENT = "persona";

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
  {
    name: "agent_bootstrap",
    description: `Call this first, at the start of every session, before anything else.

Returns one markdown brief: who you are (your persona), the owner's top preferences, active
projects, recent decisions and the gotchas most worth knowing. Pass project (a name or a
proj:<name> tag) to narrow the brief to one project. It is clipped to a few thousand tokens;
use memory_search for anything more.`,
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional project name or proj:<name> tag to focus on" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_list",
    description: `List and browse memories with pagination and optional filters, newest first.

Unlike memory_search (semantic search), this does categorical listing/filtering.

Examples:
{}
{"page": 2, "page_size": 50}
{"tags": ["proj:x", "gotcha"], "tag_match": "all"}
{"memory_type": "decision", "page_size": 10}
{"stale_days": 30}`,
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", default: 1, minimum: 1, description: "Page number (1-based)" },
        page_size: { type: "integer", default: 20, minimum: 1, maximum: 100, description: "Results per page" },
        tags: { ...TAGS_SCHEMA, description: "Filter by tags" },
        tag_match: { type: "string", enum: ["any", "all"], default: "any", description: "Match ANY tag or ALL tags" },
        memory_type: { type: "string", description: "Filter by memory type" },
        stale_days: { type: "integer", minimum: 1, description: "Only memories not accessed in the last N days" },
        agent_id: { type: "string", description: "Only memories authored by this agent. Defaults to the X-Agent-ID header when it is sent." },
        store: { type: "string", description: "Store partition (default: 'default'). Use 'all' for every store." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_delete",
    description: `Delete memories by hash, or by tags and/or a date range (AND logic). Deleted
memories are kept as tombstones in the database and leave search at once.

No filters is an error. Use dry_run=true to preview a bulk delete.

Examples:
{"content_hash": "abc123def456"}
{"tags": ["temporary", "draft"], "tag_match": "any"}
{"tags": ["cleanup"], "before": "2024-01-01", "dry_run": true}`,
    inputSchema: {
      type: "object",
      properties: {
        content_hash: { type: "string", description: "Specific memory hash to delete (ignores other filters if provided)" },
        tags: { ...TAGS_SCHEMA, description: "Filter by these tags" },
        tag_match: { type: "string", enum: ["any", "all"], default: "any", description: "Match ANY tag or ALL tags" },
        before: { type: "string", description: "Delete memories created before this date (YYYY-MM-DD)" },
        after: { type: "string", description: "Delete memories created on or after this date (YYYY-MM-DD)" },
        dry_run: { type: "boolean", default: false, description: "Preview deletions without executing" },
        store: { type: "string", description: "Store partition (default: 'default'). Use 'all' for every store." },
      },
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_update",
    description: `Update a memory's tags, type or metadata in place, keeping its content and embedding.

- updates.tags replaces the tags.
- updates.memory_type sets the type.
- updates.metadata, and any other keys in updates, merge into the metadata.

Example:
{"content_hash": "abc123...", "updates": {"tags": ["proj:x", "decision"], "metadata": {"status": "superseded"}}}`,
    inputSchema: {
      type: "object",
      properties: {
        content_hash: { type: "string", description: "The content hash of the memory to update." },
        updates: {
          type: "object",
          description: "Fields to update.",
          properties: {
            tags: { ...TAGS_SCHEMA, description: "Replace existing tags with these." },
            memory_type: { type: "string", description: "New memory type." },
            metadata: { type: "object", description: "Custom metadata fields to merge with existing metadata." },
          },
        },
      },
      required: ["content_hash", "updates"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "memory_stats",
    description: "Statistics about the stored memories: counts by type and agent, top tags, date range, stored documents.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
] as const;

// Workers AI embeds at most 100 texts per call; this keeps a store's chunks within one call.
export const MAX_STORE_CHARS = 50_000;

export class ToolError extends Error {}

export async function callTool(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  if (name === "memory_store") return storeMemory(args, ctx);
  if (name === "memory_search") return searchMemories(args, ctx);
  if (name === "agent_bootstrap") return bootstrap(args, ctx);
  if (name === "memory_list") return listMemories(args, ctx);
  if (name === "memory_delete") return deleteMemories(args, ctx);
  if (name === "memory_update") return updateMemory(args, ctx);
  if (name === "memory_stats") return stats(ctx);
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
    if (ctx.trackAccess && found.length) {
      const now = ctx.now();
      ctx.defer(ctx.store.recordAccess(found.map((m) => accessUpdate(m, req.query, now))));
    }
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
  return retrieveStage(vectorOrder, req, fetchLimit);
}

async function bootstrap(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const project = typeof args.project === "string" && args.project.trim() ? args.project : undefined;
  const [persona, memories] = await Promise.all([ctx.store.document(PERSONA_DOCUMENT), ctx.store.recent("default")]);
  return { text: buildBrief({ persona, memories, project, now: ctx.now() }) };
}

async function listMemories(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const req = parseListArgs(args, ctx.agentIdHeader);
  if ("error" in req) return { text: `Error listing memories: ${req.error}` };
  return { text: listPage(await ctx.store.recent(req.store), req, ctx.now()) };
}

async function deleteMemories(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const req = parseDeleteArgs(args);
  if ("error" in req) return { text: `Error: ${req.error}` };
  let targets: StoredMemory[];
  if (req.kind === "hash") {
    const memory = await ctx.store.byHash(req.contentHash, req.store);
    if (!memory) return { text: `Error: Memory not found: ${req.contentHash}` };
    targets = [memory];
  } else {
    targets = deleteTargets(await ctx.store.recent(req.store), req);
  }
  if (!req.dryRun && targets.length) await ctx.store.softDelete(targets, ctx.now());
  return { text: deleteReply(targets.map((m) => m.contentHash), req.dryRun, req.kind === "hash") };
}

async function updateMemory(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  const hash = typeof args.content_hash === "string" ? args.content_hash.trim() : "";
  const current = hash ? await ctx.store.byHash(hash, null) : null;
  if (hash && !current && args.updates && typeof args.updates === "object") {
    return { text: "Failed to update memory metadata: Memory not found" };
  }
  const plan = planUpdate(current ?? ({ tags: [], metadata: {} } as unknown as StoredMemory), args, ctx.now());
  if ("error" in plan) return { text: plan.error };
  if (!plan.changed) return { text: "Successfully updated memory metadata. No updates needed" };
  await ctx.store.update(hash, plan.update);
  return { text: "Successfully updated memory metadata. Memory metadata updated successfully" };
}

async function stats(ctx: CallContext): Promise<ToolResult> {
  const [memories, deleted, documents] = await Promise.all([
    ctx.store.recent(null),
    ctx.store.deletedCount(),
    ctx.store.documentNames(),
  ]);
  return { text: storageStats(memories, deleted, documents) };
}
