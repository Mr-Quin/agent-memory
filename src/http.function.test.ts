import { expect, test } from "bun:test";
import { agentIdFrom, bearerMatches } from "./http.function";

test("bearerMatches accepts only the exact key", () => {
  expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
  expect(bearerMatches("Bearer s3cre", "s3cret")).toBe(false);
  expect(bearerMatches("Bearer s3cretx", "s3cret")).toBe(false);
  expect(bearerMatches("s3cret", "s3cret")).toBe(false);
  expect(bearerMatches(null, "s3cret")).toBe(false);
  expect(bearerMatches("Bearer ", "")).toBe(false);
});

test("agentIdFrom trims and treats blank as absent", () => {
  expect(agentIdFrom(" agent-a ")).toBe("agent-a");
  expect(agentIdFrom("  ")).toBeUndefined();
  expect(agentIdFrom(null)).toBeUndefined();
});
