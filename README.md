# agent-memory

A long-term memory MCP server for agents, on Cloudflare Workers. It speaks MCP over HTTP at
`/mcp` and keeps memories in D1 (rows and tags) and Vectorize (768 dims, cosine), with embeddings
from Workers AI `@cf/baai/bge-base-en-v1.5`. There is nothing else to host.

It is a TypeScript reimplementation of two tools from
[mcp-memory-service](https://github.com/doobidoo/mcp-memory-service), compatible with that
server's Cloudflare backend as of 12.8.0: same D1 schema, same vector ids, same content hashes
and chunking, same reply text. A set of agents already on that backend can switch by changing
a URL. It is not a fork and does not track upstream; see `NOTICE` for what was ported.

## Tools

- `memory_store`: `content`, `metadata.tags` (array or comma string), `metadata.type`,
  `agent_id`, `conversation_id`, `store`. Content over 800 characters is split into chunks the
  way the Python server split it, each chunk with `chunk_index`, `total_chunks` and
  `original_hash` in its metadata. Unknown types are stored as `observation` with a warning.
- `memory_search`: `query`, `mode` (`semantic` or `exact`), `content_hash`, `tags`, `tag_match`,
  `after`, `before`, `limit`, `max_response_chars`, `agent_id`, `store`. Anything else (for
  example `time_expr`, `quality_boost`) is answered with an error naming it.

Content is capped at 50,000 characters per store.

The `X-Agent-ID` header attributes writes (`metadata.agent_id`, after an explicit `agent_id`
argument) and narrows search to that agent's memories. Without it, search sees everything.
The header names an author; it is not a credential, and any client holding the key can send any
value. Each search records `access_count`, `last_accessed_at` and the last ten queries on the
memories it retrieved, as the Python server did; set `TRACK_ACCESS=false` to turn that off.

## Layout

- `src/memory-record.function.ts`: content hash, tags, type, chunking, and the row a memory becomes.
- `src/search.function.ts`: search arguments, filters and the reply text.
- `src/tools.function.ts`: the two tools against a `MemoryStore` port.
- `src/mcp.function.ts`: JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`.
- `src/cloudflare-store.service.ts`: the port on D1, Vectorize and Workers AI.
- `src/index.service.ts`: the Worker: bearer auth, `/mcp`, `/health`.
- `schema.sql`: the Python server's D1 schema, for a scratch database.

## Develop

```bash
mise install
bun install
bun run ci
```

`.dev.vars` holds `MCP_API_KEY=<any local key>`. Remote bindings in dev need the D1 database id,
which the committed config leaves out: copy `wrangler.jsonc` to `wrangler.local.jsonc`
(ignored by git), add your `database_id`, and pass `-c wrangler.local.jsonc`. Two dev setups:

- `bunx wrangler dev --env readonly`: the deployed D1 and Vectorize with access tracking off. Only
  search against it; a store would write to live data.
- `bunx wrangler dev --env scratch`: a local D1 and the `agent-memory-scratch` Vectorize index.
  Create the schema once with
  `bunx wrangler d1 execute agent-memory-scratch --env scratch --local --file schema.sql`.

New vectors take up to a minute before Vectorize returns them.

## Deploy

```bash
bunx wrangler secret put MCP_API_KEY
bun run deploy
```

Create the D1 database (`bunx wrangler d1 create agent-memory`, then apply `schema.sql` with
`--remote`) and the index (`bunx wrangler vectorize create agent-memory --dimensions=768
--metric=cosine`) first if they do not exist. Moving from mcp-memory-service, reuse its key for
`MCP_API_KEY` so clients keep their header. The Worker needs no Cloudflare API token: D1,
Vectorize and Workers AI are bindings.

## Moving from mcp-memory-service

If mcp-memory-service already runs with its Cloudflare backend, point this Worker's bindings at
the same D1 database and Vectorize index and deploy it. Nothing is migrated: existing memories
are searchable at once and new ones look the same. Then:

1. Stop the Python server, so the two never write at once.
2. Point each client's MCP entry at `https://<worker>/mcp` with the same bearer key, keeping its
   `X-Agent-ID` header if it sends one.
3. In each client, one search and one store.

## Backup

A nightly export of the D1 database, kept locally, for example from cron:

```bash
0 3 * * * cd ~/projects/agent-memory && bunx wrangler d1 export agent-memory --remote --output "backups/agent-memory-$(date +\%F).sql"
```

The export covers Vectorize too in practice: every row keeps its content and `vector_id`, so
the index can be refilled by embedding each row again (there is no script for that yet).

## License

Apache-2.0. Includes material ported from mcp-memory-service; see `NOTICE`.
