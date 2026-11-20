import { type CallContext, callTool, PERSONA_DOCUMENT, TOOLS, ToolError } from "./tools.function";

export const SERVER_INFO = { name: "agent-memory", version: "0.1.0" };
const PERSONA_URI = "memory://persona";
const PERSONA_PROMPT = {
  name: PERSONA_DOCUMENT,
  description: "Who you are: the persona every agent on this server takes on. The agent_bootstrap tool includes it with current context.",
};
const PERSONA_RESOURCE = { uri: PERSONA_URI, name: PERSONA_DOCUMENT, mimeType: "text/markdown" };
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
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return ok(id, {});
    case "prompts/list":
      return ok(id, { prompts: [PERSONA_PROMPT] });
    case "prompts/get": {
      if (params?.name !== PERSONA_DOCUMENT) return fail(id, -32602, `Unknown prompt: ${String(params?.name)}`);
      const persona = await ctx.store.document(PERSONA_DOCUMENT);
      if (!persona) return fail(id, -32602, "No persona is stored on this server");
      return ok(id, {
        description: PERSONA_PROMPT.description,
        messages: [{ role: "user", content: { type: "text", text: persona } }],
      });
    }
    case "resources/list":
      return ok(id, { resources: [PERSONA_RESOURCE] });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "resources/read": {
      if (params?.uri !== PERSONA_URI) return fail(id, -32002, `Resource not found: ${String(params?.uri)}`);
      const persona = await ctx.store.document(PERSONA_DOCUMENT);
      if (!persona) return fail(id, -32002, "No persona is stored on this server");
      return ok(id, { contents: [{ uri: PERSONA_URI, mimeType: "text/markdown", text: persona }] });
    }
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
