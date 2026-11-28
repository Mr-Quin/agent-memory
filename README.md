# agent-memory

A long-term memory MCP server for agents, on Cloudflare Workers. It speaks MCP over HTTP at
`/mcp` and keeps memories in D1 (rows and tags) and Vectorize (768 dims, cosine), with embeddings
from Workers AI `@cf/baai/bge-base-en-v1.5`. There is nothing else to host.

`/health` and `/mcp/health` answer without auth. `/mcp` and `/mcp/` return 401 without a valid
bearer key, take POST with one, and answer 405 to GET; there is no SSE stream.

It is a TypeScript reimplementation of the core tools of
[mcp-memory-service](https://github.com/doobidoo/mcp-memory-service), compatible with that
server's Cloudflare backend as of 12.8.0: same D1 schema, same vector ids, same content hashes
and chunking, same reply text. It is not a fork and does not track upstream; see `NOTICE`.

## Tools

The MCP schema lists each tool's arguments.

- `agent_bootstrap`: call it first. One markdown brief: the persona, the owner's preferences,
  active projects, recent decisions and common gotchas. Built from the data alone, with no model
  call.
- `memory_store`: save a memory. Content over 800 characters is chunked as the Python server
  chunked it. Unknown types are stored as `observation` with a warning.
- `memory_search`: semantic or exact search with tag, date and agent filters.
- `memory_list`: newest first, with filters.
- `memory_delete`: by hash, tags or date range. Rows stay as tombstones (`deleted_at`) and their
  vectors are removed.
- `memory_update`: change tags, type or metadata. Content stays; versioned updates are not
  supported.
- `memory_stats`: counts, top tags and stored documents.

Unsupported arguments (for example `time_expr` on search) are answered with an error naming them.

The persona is also served as the MCP prompt `persona` and the resource `memory://persona`, but
`agent_bootstrap` is the one to rely on, since some clients turn prompts and resources off.

The `X-Agent-ID` header attributes writes and narrows search and list to that agent's memories;
`agent_bootstrap` always sees everything. The header names an author; it is not a credential, and
any client holding the key can send any value. Each semantic search records access counts on the
memories it retrieved, as the Python server did; set `TRACK_ACCESS=false` to turn that off.

## Persona

The persona is a document in the `documents` table of the same D1 database, under the name
`persona`. Push it, or a new version of it, with:

```bash
bun scripts/push-document.script.ts persona path/to/persona.md --remote
```

`--local --env scratch` writes to the local scratch database instead.

## Develop

```bash
mise install && bun install && bun run ci
```

`.dev.vars` holds `MCP_API_KEY=<any local key>`. Remote bindings in dev need the D1 database id,
which the committed config leaves out: copy `wrangler.jsonc` to `wrangler.local.jsonc`
(ignored by git), add your `database_id` to the D1 binding under `env.readonly`, and pass
`-c wrangler.local.jsonc`. Two dev setups:

- `bunx wrangler dev -c wrangler.local.jsonc --env readonly`: the deployed D1 and Vectorize with
  access tracking off. It does not block writes: store, update and delete change live data, so
  only search against it.
- `bunx wrangler dev --env scratch`: a local D1 and the `agent-memory-scratch` Vectorize index.
  Create the index once with
  `bunx wrangler vectorize create agent-memory-scratch --dimensions=768 --metric=cosine` and the
  schema with `bunx wrangler d1 execute agent-memory-scratch --env scratch --local --file schema.sql`.

New vectors take up to a minute before Vectorize returns them.

## Deploy

One-time setup, before either path: create the D1 database (`bunx wrangler d1 create
agent-memory`, then apply `schema.sql` with `--remote`), create the index (`bunx wrangler
vectorize create agent-memory --dimensions=768 --metric=cosine`) and set the key with
`bunx wrangler secret put MCP_API_KEY`. The Worker needs no Cloudflare API token: D1, Vectorize
and Workers AI are bindings.

Workers Builds deploys a push to `main` once the repository is connected under the Worker's
Settings → Builds with build command `bun run ci`, deploy command `npx wrangler deploy` and the
build variable `BUN_VERSION` set to the version in `mise.toml`. The build runs CI first. The manual
`bun run deploy` skips CI.

## Moving from mcp-memory-service

Point this Worker's bindings at the same D1 database and Vectorize index and deploy it; nothing
is migrated. Reuse its `MCP_API_KEY` and stop the Python server so the two never write at once.
Then point each client at `https://<worker>/mcp`, keeping its `X-Agent-ID` header, and try one
search and one store.

## License

Apache-2.0. Includes material ported from mcp-memory-service; see `NOTICE`.
