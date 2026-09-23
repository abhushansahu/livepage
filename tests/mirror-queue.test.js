import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentServer } from "../host/server.mjs";
import { drainMirror } from "../extension/storage/mirror.js";
import {
  ackMirror,
  mirrorPendingCount,
  onMirrorEnqueued,
  pendingMirror,
  saveSettings,
  upsertPageFromVisit
} from "../extension/storage/store.js";

// The one part of the mirror the other tests cannot reach: a real write to
// the store, noted by the transaction wrapper, waiting in the queue, and then
// carried to a real host over HTTP.
test("every store write lands in the mirror queue and drains to the host", async () => {
  let triggered = 0;
  onMirrorEnqueued(() => triggered++);

  await saveSettings({ agentHostToken: "" });
  const page = await upsertPageFromVisit("https://example.com/essay", { title: "An essay" });
  assert.ok(page.id);
  assert.ok(triggered >= 2, "the trigger fires once per committed write");

  const queued = await pendingMirror(50);
  const stores = queued.map((row) => `${row.entry.op}:${row.entry.store}`);
  assert.ok(stores.includes("put:settings"));
  assert.ok(stores.includes("put:pages"));
  const pageOp = queued.find((row) => row.entry.store === "pages");
  assert.equal(pageOp.entry.key, page.id, "the key is read off the store's keyPath");
  assert.equal(pageOp.entry.doc.title, "An essay");
  assert.ok(!stores.some((s) => s.endsWith(":mirror")), "the queue never mirrors itself");

  // Unpaired: nothing moves, nothing is lost.
  const before = await mirrorPendingCount();
  assert.deepEqual(await drainMirror({ agentHostToken: "" }), { ok: false, reason: "unpaired", sent: 0 });
  assert.equal(await mirrorPendingCount(), before);

  // A host that is down: same.
  const down = await drainMirror({ agentHostToken: "tok", agentHostUrl: "http://127.0.0.1:1" });
  assert.equal(down.reason, "unreachable");
  assert.equal(await mirrorPendingCount(), before);

  // A live host: the queue empties into it and the rows are what the browser wrote.
  const { server, mirror } = await createAgentServer({ token: "tok", dbPath: ":memory:", ask: async () => ({ text: "" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await drainMirror({ agentHostToken: "tok", agentHostUrl: `http://127.0.0.1:${port}` });
    assert.equal(result.ok, true);
    assert.equal(result.drained, true);
    assert.equal(await mirrorPendingCount(), 0);
    const hostPages = mirror.dump("pages");
    assert.equal(hostPages.length, 1);
    assert.equal(hostPages[0].doc.title, "An essay");
    assert.equal(mirror.dump("settings")[0].doc.value.agentHostToken, "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await ackMirror([]);
  onMirrorEnqueued(null);
});
