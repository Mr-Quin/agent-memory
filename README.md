# agent-memory

A long-term memory MCP server for agents, on Cloudflare Workers. It speaks MCP over HTTP at
`/mcp` and keeps memories in D1 (rows and tags) and Vectorize (768 dims, cosine), with embeddings
from Workers AI `@cf/baai/bge-base-en-v1.5`. There is nothing else to host.

`/health` and `/mcp/health` answer without auth. `/mcp` (and `/mcp/`) takes POST with the bearer
key; GET gets 405, and there is no SSE stream.

It is a TypeScript reimplementation of the core tools of
[mcp-memory-service](https://github.com/doobidoo/mcp-memory-service), compatible with that
server's Cloudflare backend as of 12.8.0: same D1 schema, same vector ids, same content hashes
and chunking, same reply text. A set of agents already on that backend can switch by changing
a URL. It is not a fork and does not track upstream; see `NOTICE` for what was ported.

## Tools

- `agent_bootstrap`: call it first. Returns one markdown brief of a few thousand tokens at
  most: the persona stored on the server, the owner's preferences (memories tagged `user:owner`
  of type `preference_signal`), active projects (`proj:*` tags of the last 30 days), recent
  decisions and the most-read gotchas. `project` narrows it to one `proj:` tag. Built from the
  data alone, with no model call, so the same data gives the same brief.
- `memory_store`: `content`, `metadata.tags` (array or comma string), `metadata.type`,
  `agent_id`, `conversation_id`, `store`. Content over 800 characters is split into chunks the
  way the Python server split it, each chunk with `chunk_index`, `total_chunks` and
  `original_hash` in its metadata. Unknown types are stored as `observation` with a warning.
- `memory_search`: `query`, `mode` (`semantic` or `exact`), `content_hash`, `tags`, `tag_match`,
  `after`, `before`, `limit`, `max_response_chars`, `agent_id`, `store`.
- `memory_list`: newest first, `page`, `page_size`, `tags`, `tag_match`, `memory_type`,
  `stale_days`, `agent_id`, `store`; JSON in the Python server's shape.
- `memory_delete`: by `content_hash`, or by `tags` and/or `before`/`after`, with `dry_run`.
  Rows are kept as tombstones (`deleted_at`) and their vectors removed, as the Python server did.
- `memory_update`: `content_hash` and `updates`: `tags` replaces, `memory_type` sets,
  `metadata` and other keys merge. Content stays; versioned updates are not supported.
- `memory_stats`: counts by type and agent, top tags, date range and stored documents. (The
  Python server's tool of this name reports its process caches instead.)

Arguments a tool does not support (for example `time_expr` on search) are answered with an
error naming them. Content is capped at 50,000 characters per store.

The persona is also served as the MCP prompt `persona` and the resource `memory://persona`, for
clients that read those. `agent_bootstrap` is the one to rely on, since some clients turn
prompts and resources off.

The `X-Agent-ID` header attributes writes (`metadata.agent_id`, after an explicit `agent_id`
argument) and narrows search and list to that agent's memories. Without it they see everything;
`agent_bootstrap` always sees everything. The header names an author; it is not a credential,
and any client holding the key can send any value. Each semantic search records
`access_count`, `last_accessed_at` and the last ten queries on the memories it retrieved, as the
Python server did; set `TRACK_ACCESS=false` to turn that off.

## Persona

The persona is a document in the `documents` table of the same D1 database, under the name
`persona`. Push it, or a new version of it, with:

```bash
bun scripts/push-document.script.ts persona path/to/persona.md --remote
```

`--local --env scratch` writes to the local scratch database instead. The script creates the
table if it is missing; nothing else in the Python server's schema changes.

Live state (open tasks, running jobs) is not part of the brief yet. It would come from the
systems that hold it, not from memories.

## Layout

- `src/memory-record.function.ts`: content hash, tags, type, chunking, and the row a memory becomes.
- `src/search.function.ts`: search arguments, filters and the reply text.
- `src/tools.function.ts`: the tools against a `MemoryStore` port.
- `src/bootstrap.function.ts`: the bootstrap brief.
- `src/manage.function.ts`: list, delete, update and stats.
- `src/document-sql.function.ts` and `scripts/push-document.script.ts`: storing a document such as the persona.
- `src/mcp.function.ts`: JSON-RPC: tools, the persona prompt and resource.
- `src/cloudflare-store.service.ts`: the port on D1, Vectorize and Workers AI.
- `src/index.service.ts`: the Worker: bearer auth, `/mcp`, `/health`.
- `schema.sql`: the Python server's D1 schema plus the `documents` table, for a scratch database.

## Develop

```bash
mise install
bun install
bun run ci
```

`.dev.vars` holds `MCP_API_KEY=<any local key>`. Remote bindings in dev need the D1 database id,
which the committed config leaves out: copy `wrangler.jsonc` to `wrangler.local.jsonc`
(ignored by git), add your `database_id`, and pass `-c wrangler.local.jsonc`. Two dev setups:

- `bunx wrangler dev --env readonly`: the deployed D1 and Vectorize with access tracking off. It
  does not block writes: store, update and delete change live data, so only search against it.
- `bunx wrangler dev --env scratch`: a local D1 and the `agent-memory-scratch` Vectorize index.
  Create the index once with
  `bunx wrangler vectorize create agent-memory-scratch --dimensions=768 --metric=cosine` and the
  schema with `bunx wrangler d1 execute agent-memory-scratch --env scratch --local --file schema.sql`.

New vectors take up to a minute before Vectorize returns them.

## Deploy

A push to `main` deploys through Workers Builds. Connect the repository under the Worker's
Settings → Builds with build command `bun run ci`, deploy command `npx wrangler deploy` and the
build variable `BUN_VERSION` set to the version in `mise.toml`. A commit that fails CI is not
deployed.

Either way, set the key once with `bunx wrangler secret put MCP_API_KEY`. To deploy by hand
instead, run `bun run deploy`.

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
