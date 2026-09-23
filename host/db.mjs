/**
 * The host's copy of everything the extension keeps.
 *
 * Step one of moving the store out of the browser: the extension still reads
 * and writes IndexedDB, and mirrors every write here as it happens. Nothing
 * reads from this file yet, so a bug here cannot lose a highlight — but by
 * the time the switch is flipped, this file has been receiving every change
 * for days and can be compared against the browser's copy row by row.
 *
 * The shape is deliberately the browser's shape: one row per IndexedDB record,
 * keyed by store name and the record's own key, with the record as JSON. Real
 * tables come with step two, once this is the source of truth and the schema
 * can be designed for queries rather than for faithfulness.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STORES = ["pages", "settings", "ledger", "events", "mind", "vaultMeta", "markup", "glossary"];

export function defaultDbPath() {
  return process.env.LIVEPAGE_DB_PATH || join(homedir(), ".livepage", "livepage.db");
}

export function openMirror(path = defaultDbPath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (
      store TEXT NOT NULL,
      key TEXT NOT NULL,
      doc TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (store, key)
    );
    CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated_at);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const upsert = db.prepare(
    `INSERT INTO docs (store, key, doc, updated_at, deleted) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(store, key) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at, deleted = 0`
  );
  const tombstone = db.prepare(
    `INSERT INTO docs (store, key, doc, updated_at, deleted) VALUES (?, ?, '{}', ?, 1)
     ON CONFLICT(store, key) DO UPDATE SET doc = '{}', updated_at = excluded.updated_at, deleted = 1`
  );
  const wipe = db.prepare(`UPDATE docs SET doc = '{}', deleted = 1, updated_at = ? WHERE store = ?`);
  const counts = db.prepare(
    `SELECT store, SUM(deleted = 0) AS live, SUM(deleted = 1) AS gone, MAX(updated_at) AS latest FROM docs GROUP BY store`
  );
  const rows = db.prepare(`SELECT key, doc, updated_at FROM docs WHERE store = ? AND deleted = 0 ORDER BY key`);
  const setMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const getMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`);

  /**
   * Applies a batch of browser writes in one transaction. An op is
   * {op: "put"|"delete"|"clear", store, key?, doc?, at?}. Unknown stores are
   * refused rather than created, so a typo on the browser side cannot grow
   * the schema; the whole batch is rejected so the browser retries it intact.
   */
  function applyBatch(ops) {
    if (!Array.isArray(ops)) throw new Error("ops must be an array");
    for (const op of ops) validateOp(op);
    const now = Date.now();
    db.exec("BEGIN");
    try {
      for (const op of ops) {
        const at = Number.isFinite(op.at) ? op.at : now;
        if (op.op === "put") upsert.run(op.store, String(op.key), JSON.stringify(op.doc), at);
        else if (op.op === "delete") tombstone.run(op.store, String(op.key), at);
        else wipe.run(at, op.store);
      }
      setMeta.run("lastBatchAt", String(now));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { applied: ops.length, at: now };
  }

  function status() {
    const byStore = {};
    for (const row of counts.all()) {
      byStore[row.store] = { live: Number(row.live), gone: Number(row.gone), latest: Number(row.latest) || 0 };
    }
    const last = getMeta.get("lastBatchAt");
    return { path, stores: byStore, lastBatchAt: last ? Number(last.value) : 0 };
  }

  function dump(store) {
    if (!STORES.includes(store)) throw new Error(`Unknown store: ${store}`);
    return rows.all(store).map((row) => ({ key: row.key, doc: JSON.parse(row.doc), updatedAt: row.updated_at }));
  }

  return { applyBatch, status, dump, close: () => db.close() };
}

function validateOp(op) {
  if (!op || typeof op !== "object") throw new Error("Bad op");
  if (!STORES.includes(op.store)) throw new Error(`Unknown store: ${op.store}`);
  if (op.op === "clear") return;
  if (op.op !== "put" && op.op !== "delete") throw new Error(`Unknown op: ${op.op}`);
  if (op.key === undefined || op.key === null || String(op.key) === "") throw new Error("Missing key");
  if (op.op === "put" && (op.doc === null || typeof op.doc !== "object")) throw new Error("Missing doc");
}
