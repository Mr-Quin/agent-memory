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

  test("lists the tools", async () => {
    const reply = (await rpc("tools/list")).body as { result: { tools: { name: string }[] } };
    expect(reply.result.tools.map((t) => t.name)).toEqual([
      "memory_store", "memory_search", "agent_bootstrap", "memory_list", "memory_delete", "memory_update", "memory_stats",
    ]);
  });

  test("serves the stored persona as a prompt and a resource", async () => {
    const store = new FakeStore();
    store.documents.set("persona", "You are Ada.");
    const call = (method: string, params: unknown) => handleRpc({ jsonrpc: "2.0", id: 1, method, params }, fakeContext(store));
    expect((await call("prompts/get", { name: "persona" })).body).toMatchObject({
      result: { messages: [{ role: "user", content: { type: "text", text: "You are Ada." } }] },
    });
    expect((await call("resources/read", { uri: "memory://persona" })).body).toMatchObject({
      result: { contents: [{ uri: "memory://persona", text: "You are Ada." }] },
    });
    expect((await call("prompts/get", { name: "other" })).body).toMatchObject({ error: { code: -32602 } });
  });

  test("says so when no persona is stored", async () => {
    expect((await rpc("resources/read", { uri: "memory://persona" })).body).toMatchObject({
      error: { message: "No persona is stored on this server" },
    });
  });

  test("wraps a tool result and flags tool errors in the result, not as RPC errors", async () => {
    const stored = await rpc("tools/call", { name: "memory_store", arguments: { content: "x" } });
    expect(stored.body).toMatchObject({ result: { content: [{ type: "text" }] } });
    const empty = await rpc("tools/call", { name: "memory_store", arguments: {} });
    expect(empty.body).toMatchObject({ result: { isError: true, content: [{ text: "Content is required" }] } });
  });

  test("rejects unknown tools and methods, and a call without a name", async () => {
    expect((await rpc("tools/call", { name: "memory_consolidate" })).body).toMatchObject({ error: { code: -32601 } });
    expect((await rpc("sampling/createMessage")).body).toMatchObject({ error: { code: -32601 } });
    expect(await rpc("tools/call", {})).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
  });
});
