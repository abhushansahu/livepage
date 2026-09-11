import assert from "node:assert/strict";
import http from "node:http";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { claudeArgs, parseAgentOutput, prepareWorkspace } from "../host/ask.mjs";
import {
  hostHeaderAllowed,
  listenAddress,
  originAllowed,
  tokenMatches
} from "../host/guard.mjs";
import { createAgentServer } from "../host/server.mjs";

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

test("a Claude ask may look things up, and has the turns to do it", () => {
  const args = claudeArgs({ packet: "# LivePage\n", workspace: "/tmp/ws", model: "sonnet", resumeId: "" });
  const tools = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  assert.ok(tools.includes("WebFetch"), "an agent that cannot open a link cannot check a source");
  assert.ok(tools.includes("WebSearch"));
  // One turn is not enough to reach for anything: asking for a page and
  // reading it both cost a turn before there is a word to say.
  assert.ok(Number(args[args.indexOf("--max-turns") + 1]) > 2);
});

test("the tool allowlist is last, so it cannot swallow the flags after it", () => {
  const args = claudeArgs({ packet: "x", workspace: "/tmp/ws", model: "opus", resumeId: "ses_1" });
  assert.equal(args.indexOf("--allowedTools"), args.lastIndexOf("--allowedTools"));
  assert.ok(args.indexOf("--model") < args.indexOf("--allowedTools"));
  assert.ok(args.indexOf("--resume") < args.indexOf("--allowedTools"));
});

test("a reading surface never asks the reader for a shell", () => {
  const args = claudeArgs({ packet: "x", workspace: "/tmp/ws", model: "", resumeId: "" });
  const denied = args.slice(args.indexOf("--disallowedTools") + 1);
  for (const tool of ["Bash", "Edit", "Write"]) assert.ok(denied.includes(tool), tool);
});

test("a run that ran out of turns is not reported as a login problem", () => {
  const parsed = parseAgentOutput(
    JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns", session_id: "ses_9" })
  );
  assert.equal(parsed.text, "");
  assert.equal(parsed.error, "error_max_turns");
});

test("guard rejects public origins and non-loopback Host headers", () => {
  assert.equal(originAllowed(""), true);
  assert.equal(originAllowed("chrome-extension://abcdefghijklmnopqrstuvwxyz"), true);
  assert.equal(originAllowed("https://evil.example"), false);
  assert.equal(originAllowed("null"), false);
  assert.equal(hostHeaderAllowed("127.0.0.1:17321"), true);
  assert.equal(hostHeaderAllowed("localhost"), true);
  assert.equal(hostHeaderAllowed("evil.example"), false);
  assert.equal(hostHeaderAllowed("0.0.0.0:17321"), false);
  assert.equal(tokenMatches("abcd", "abcd"), true);
  assert.equal(tokenMatches("abcd", "abce"), false);
});

test("listenAddress refuses a non-loopback bind", () => {
  const prev = process.env.LIVEPAGE_AGENT_HOST;
  process.env.LIVEPAGE_AGENT_HOST = "0.0.0.0";
  try {
    assert.throws(() => listenAddress(), /Loopback only/);
  } finally {
    if (prev === undefined) delete process.env.LIVEPAGE_AGENT_HOST;
    else process.env.LIVEPAGE_AGENT_HOST = prev;
  }
});

test("prepareWorkspace writes under the os temp dir, not a caller path", async () => {
  const dir = await prepareWorkspace("# packet\n", "");
  assert.match(dir, /livepage-agent-/);
  const actual = await realpath(dir);
  const temp = await realpath(tmpdir());
  assert.equal(actual.startsWith(temp), true);
});

test("agent host rejects web origins and unauthenticated asks", async () => {
  const seen = [];
  const { server } = await createAgentServer({
    token: "test-token-value",
    ask: async (body) => {
      seen.push(body);
      return { text: "ok", sessionId: "ses" };
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const blocked = await request(port, {
      path: "/pair",
      headers: { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" }
    });
    assert.equal(blocked.status, 403);

    const paired = await request(port, {
      path: "/pair",
      headers: { Host: `127.0.0.1:${port}` }
    });
    assert.equal(paired.status, 200);
    assert.match(paired.body, /test-token-value/);

    const unauth = await request(port, {
      method: "POST",
      path: "/ask",
      headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ packet: "hi", cwd: "/tmp/pwn", cursorPath: "/bin/sh" })
    });
    assert.equal(unauth.status, 401);
    assert.equal(seen.length, 0);

    const authed = await request(port, {
      method: "POST",
      path: "/ask",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-value"
      },
      body: JSON.stringify({ packet: "hi", cwd: "/tmp/pwn", cursorPath: "/bin/sh" })
    });
    assert.equal(authed.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cwd, undefined);
    assert.equal(seen[0].cursorPath, undefined);
    assert.equal(JSON.parse(authed.body).text, "ok");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

function request(port, { method = "GET", path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
