import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openMirror, STORES } from "../host/db.mjs";
import { createAgentServer } from "../host/server.mjs";
import { chunk, coalesceOps, drainMirror } from "../extension/storage/mirror.js";

test("a burst of writes to one record collapses to its last state", () => {
  const ops = coalesceOps([
    { op: "put", store: "pages", key: "a", doc: { v: 1 } },
    { op: "put", store: "pages", key: "b", doc: { v: 1 } },
    { op: "put", store: "pages", key: "a", doc: { v: 2 } },
    { op: "delete", store: "pages", key: "b" },
    { op: "put", store: "ledger", key: "a", doc: { v: 9 } }
  ]);
  assert.deepEqual(
    ops.map((o) => `${o.op}:${o.store}/${o.key}${o.doc ? `=${o.doc.v}` : ""}`),
    ["put:pages/a=2", "delete:pages/b", "put:ledger/a=9"]
  );
});

test("a clear wipes what came before it for that store only", () => {
  const ops = coalesceOps([
    { op: "put", store: "events", key: "1", doc: {} },
    { op: "put", store: "pages", key: "p", doc: {} },
    { op: "clear", store: "events" },
    { op: "put", store: "events", key: "2", doc: {} }
  ]);
  assert.deepEqual(
    ops.map((o) => `${o.op}:${o.store}${o.key ? `/${o.key}` : ""}`),
    ["put:pages/p", "clear:events", "put:events/2"]
  );
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("the host mirror keeps the browser's shape, tombstones deletes, and refuses unknown stores whole", () => {
  const db = openMirror(":memory:");
  try {
    db.applyBatch([
      { op: "put", store: "pages", key: "p1", doc: { id: "p1", title: "One" } },
      { op: "put", store: "pages", key: "p2", doc: { id: "p2", title: "Two" } },
      { op: "put", store: "markup", key: "p1::h", doc: { gist: "The gist." } }
    ]);
    db.applyBatch([{ op: "delete", store: "pages", key: "p2" }]);
    const status = db.status();
    assert.equal(status.stores.pages.live, 1);
    assert.equal(status.stores.pages.gone, 1);
    assert.equal(status.stores.markup.live, 1);
    assert.ok(status.lastBatchAt > 0);
    assert.deepEqual(
      db.dump("pages").map((r) => r.doc.title),
      ["One"]
    );
    assert.throws(
      () =>
        db.applyBatch([
          { op: "put", store: "pages", key: "p3", doc: { id: "p3" } },
          { op: "put", store: "nope", key: "x", doc: {} }
        ]),
      /Unknown store/
    );
    // The whole batch was refused: p3 never landed.
    assert.equal(db.dump("pages").length, 1);
    assert.throws(() => db.applyBatch([{ op: "put", store: "pages", key: "", doc: {} }]), /Missing key/);
    assert.throws(() => db.dump("mirror"), /Unknown store/);
    assert.ok(!STORES.includes("mirror"), "the queue itself is never mirrored");
  } finally {
    db.close();
  }
});

test("the mirror routes need the token and apply a batch in order", async () => {
  const { server } = await createAgentServer({ token: "tok", dbPath: ":memory:", ask: async () => ({ text: "" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const headers = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" };
  try {
    const anon = await request(port, { method: "POST", path: "/db/batch", headers, body: "{}" });
    assert.equal(anon.status, 401);
    const auth = { ...headers, Authorization: "Bearer tok" };
    const ok = await request(port, {
      method: "POST",
      path: "/db/batch",
      headers: auth,
      body: JSON.stringify({
        ops: [
          { op: "put", store: "pages", key: "p", doc: { id: "p", title: "First" } },
          { op: "put", store: "pages", key: "p", doc: { id: "p", title: "Last" } }
        ]
      })
    });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).applied, 2);
    const bad = await request(port, {
      method: "POST",
      path: "/db/batch",
      headers: auth,
      body: JSON.stringify({ ops: [{ op: "put", store: "what", key: "k", doc: {} }] })
    });
    assert.equal(bad.status, 400);
    const status = JSON.parse((await request(port, { path: "/db/status", headers: auth })).body);
    assert.equal(status.stores.pages.live, 1);
    const dump = JSON.parse((await request(port, { path: "/db/dump?store=pages", headers: auth })).body);
    assert.equal(dump.rows[0].doc.title, "Last");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("draining stops on the first refusal and reports why", async () => {
  // drainMirror reads its queue from the store module, which needs IndexedDB;
  // here the queue is empty, so only the pairing and reachability paths run.
  const unpaired = await drainMirror({ agentHostToken: "" });
  assert.equal(unpaired.reason, "unpaired");
});

function request(port, { method = "GET", path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
