import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentOutput } from "../host/ask.mjs";

test("parseAgentOutput reads Cursor/Claude json result and session id", () => {
  const parsed = parseAgentOutput(
    JSON.stringify({
      type: "result",
      result: "That highlight is the decision site.",
      session_id: "ses_123"
    })
  );
  assert.equal(parsed.text, "That highlight is the decision site.");
  assert.equal(parsed.sessionId, "ses_123");
});

test("parseAgentOutput prefers the last json line in ndjson", () => {
  const parsed = parseAgentOutput(
    [
      JSON.stringify({ type: "assistant", message: { content: [{ text: "partial" }] } }),
      JSON.stringify({ type: "result", result: "final answer", session_id: "abc" })
    ].join("\n")
  );
  assert.equal(parsed.text, "final answer");
  assert.equal(parsed.sessionId, "abc");
});

test("parseAgentOutput keeps plain text replies", () => {
  const parsed = parseAgentOutput("Just a paragraph.");
  assert.equal(parsed.text, "Just a paragraph.");
  assert.equal(parsed.sessionId, "");
});
