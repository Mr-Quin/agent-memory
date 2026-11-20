import { type CallContext, callTool, TOOLS, ToolError } from "./tools.function";

export const SERVER_INFO = { name: "agent-memory", version: "0.1.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface RpcReply {
  status: number;
  body?: unknown;
}

type Id = string | number;

const ok = (id: Id, result: unknown): RpcReply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
const fail = (id: Id | null, code: number, message: string, status = 200): RpcReply => ({
  status,
  body: { jsonrpc: "2.0", id, error: { code, message } },
});

export async function handleRpc(message: unknown, ctx: CallContext): Promise<RpcReply> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return fail(null, -32600, "Invalid Request", 400);
  }
  const { id, method, params } = message as { id?: Id | null; method?: unknown; params?: Record<string, unknown> };
  if (id === undefined || id === null) return { status: 202 };
  if (typeof method !== "string") return fail(id, -32600, "Invalid Request", 400);

  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string" || !name) {
        return fail(id, -32602, "Invalid params: 'name' is required for tools/call", 400);
      }
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32601, `Method not found: ${name}`);
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(name, args, ctx);
        return ok(id, {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (error) {
        const text = error instanceof ToolError || error instanceof Error ? error.message : String(error);
        return ok(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
