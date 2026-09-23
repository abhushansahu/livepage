/**
 * The mirror: every write the browser makes, sent on to the host's database.
 *
 * IndexedDB is still the store the extension reads from. This module only
 * makes sure the host's copy catches up: writes land in a queue inside
 * IndexedDB the moment they commit, and the queue drains to the host whenever
 * it is reachable. A host that is down costs nothing but a longer queue; a
 * batch the host refuses stays in the queue and is retried whole, so the two
 * copies never disagree on order.
 *
 * The pure parts — collapsing a burst of writes to the same record, cutting
 * the queue into batches — live here so they can be tested without a browser.
 */

import { agentHostUrl } from "../agent/host-client.js";
import { ackMirror, mirrorPendingCount, pendingMirror } from "./store.js";

export const BATCH_SIZE = 200;

/**
 * A page that is patched five times in a second only needs its last state on
 * the host. Later ops win; a clear wipes everything before it for that store;
 * a delete after a put keeps only the delete. Order of surviving ops is kept
 * so the host applies them as the browser did.
 */
export function coalesceOps(ops) {
  const out = [];
  for (const op of ops) {
    if (op.op === "clear") {
      for (let i = out.length - 1; i >= 0; i--) if (out[i].store === op.store) out.splice(i, 1);
    } else {
      const key = String(op.key);
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].op !== "clear" && out[i].store === op.store && String(out[i].key) === key) {
          out.splice(i, 1);
          break;
        }
      }
    }
    out.push(op);
  }
  return out;
}

export function chunk(items, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Sends what is queued. Returns how many ops the host took and why it
 * stopped, if it did. `unauthorized` means the caller should re-pair and call
 * again; anything else means try later.
 */
export async function drainMirror(settings, { fetchImpl = fetch, limit = 10 } = {}) {
  const token = String(settings?.agentHostToken || "").trim();
  if (!token) return { ok: false, reason: "unpaired", sent: 0 };
  let sent = 0;
  for (let round = 0; round < limit; round++) {
    const rows = await pendingMirror(BATCH_SIZE);
    if (!rows.length) return { ok: true, sent, drained: true };
    const ops = coalesceOps(rows.map((row) => row.entry));
    let res;
    try {
      res = await fetchImpl(`${agentHostUrl(settings)}/db/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ops }),
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      return { ok: false, reason: "unreachable", sent };
    }
    if (res.status === 401) return { ok: false, reason: "unauthorized", sent };
    if (!res.ok) {
      let error = "";
      try {
        error = (await res.json()).error || "";
      } catch {
        /* no body */
      }
      return { ok: false, reason: "refused", error, sent };
    }
    await ackMirror(rows.map((row) => row.id));
    sent += ops.length;
  }
  return { ok: true, sent, drained: (await mirrorPendingCount()) === 0 };
}

export async function mirrorHostStatus(settings, { fetchImpl = fetch } = {}) {
  const token = String(settings?.agentHostToken || "").trim();
  if (!token) return null;
  try {
    const res = await fetchImpl(`${agentHostUrl(settings)}/db/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
