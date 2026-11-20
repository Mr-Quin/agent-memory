import { describe, expect, test } from "bun:test";
import { FakeStore, fakeContext } from "./fake-store.testing";
import { handleRpc } from "./mcp.function";

const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  handleRpc({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }, fakeContext(new FakeStore()));

describe("handleRpc", () => {
  test("answers a notification with 202 and no body", async () => {
    expect(await rpc("notifications/initialized", undefined, null)).toEqual({ status: 202 });
  });

  test("initializes with the client's protocol version when known", async () => {
    const reply = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(reply.body).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    const old = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(old.body).toMatchObject({ result: { protocolVersion: "2024-11-05" } });
  });

  test("lists the two tools", async () => {
    const reply = (await rpc("tools/list")).body as { result: { tools: { name: string }[] } };
    expect(reply.result.tools.map((t) => t.name)).toEqual(["memory_store", "memory_search"]);
  });

  test("wraps a tool result and flags tool errors in the result, not as RPC errors", async () => {
    const stored = await rpc("tools/call", { name: "memory_store", arguments: { content: "x" } });
    expect(stored.body).toMatchObject({ result: { content: [{ type: "text" }] } });
    const empty = await rpc("tools/call", { name: "memory_store", arguments: {} });
    expect(empty.body).toMatchObject({ result: { isError: true, content: [{ text: "Content is required" }] } });
  });

  test("rejects unknown tools and methods, and a call without a name", async () => {
    expect((await rpc("tools/call", { name: "memory_delete" })).body).toMatchObject({ error: { code: -32601 } });
    expect((await rpc("resources/list")).body).toMatchObject({ error: { code: -32601 } });
    expect(await rpc("tools/call", {})).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
  });
});
