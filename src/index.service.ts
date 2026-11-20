import { CloudflareMemoryStore } from "./cloudflare-store.service";
import { agentIdFrom, bearerMatches } from "./http.function";
import { handleRpc } from "./mcp.function";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp/health" || pathname === "/health") return json({ status: "healthy", protocol: "mcp" });
    if (pathname !== "/mcp" && pathname !== "/mcp/") return json({ error: "not found" }, 404);
    if (!bearerMatches(request.headers.get("authorization"), env.MCP_API_KEY)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    let message: unknown;
    try {
      message = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }

    const reply = await handleRpc(message, {
      store: new CloudflareMemoryStore(env),
      agentIdHeader: agentIdFrom(request.headers.get("x-agent-id")),
      now: () => Date.now() / 1000,
      trackAccess: env.TRACK_ACCESS !== "false",
      defer: (work) => ctx.waitUntil(work.catch((e) => console.error("access tracking failed", e))),
    });
    return reply.body === undefined ? new Response(null, { status: reply.status }) : json(reply.body, reply.status);
  },
} satisfies ExportedHandler<Env>;
