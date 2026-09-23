import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAsk, listModels, probeClis } from "./ask.mjs";
import { journal, logPath, looksLikeMarkupPacket, shapeOfMarkupReply } from "./journal.mjs";
import { defaultDbPath, openMirror } from "./db.mjs";
import {
  DEFAULT_PORT,
  bearerToken,
  hostHeaderAllowed,
  listenAddress,
  loadOrCreateToken,
  originAllowed,
  tokenMatches
} from "./guard.mjs";

export async function createAgentServer({ token, ask = handleAsk, dbPath = defaultDbPath() } = {}) {
  const port = Number(process.env.LIVEPAGE_AGENT_PORT || DEFAULT_PORT);
  const host = listenAddress();
  const secret = token || (await loadOrCreateToken());
  const mirror = openMirror(dbPath);

  const server = http.createServer(async (req, res) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(originAllowed(req.headers.origin) ? 204 : 403);
      res.end();
      return;
    }
    try {
      if (!hostHeaderAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
        json(res, 403, { ok: false, error: "Forbidden" });
        return;
      }
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      if (req.method === "GET" && url.pathname === "/pair") {
        json(res, 200, { ok: true, token: secret });
        return;
      }
      const authed = tokenMatches(secret, bearerToken(req.headers.authorization));
      if (req.method === "GET" && url.pathname === "/health") {
        if (!authed) {
          json(res, 200, { ok: true, auth: false });
          return;
        }
        const clis = await probeClis();
        json(res, 200, { ok: true, auth: true, ...clis });
        return;
      }
      if (!authed) {
        json(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      // The mirror: every browser write, in order, in one transaction per
      // batch. A refused batch is refused whole so the browser keeps it.
      if (req.method === "POST" && url.pathname === "/db/batch") {
        const body = await readJson(req);
        try {
          json(res, 200, { ok: true, ...mirror.applyBatch(body.ops) });
        } catch (error) {
          json(res, 400, { ok: false, error: error.message || String(error) });
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/db/status") {
        json(res, 200, { ok: true, ...mirror.status() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/db/dump") {
        try {
          json(res, 200, { ok: true, rows: mirror.dump(url.searchParams.get("store") || "") });
        } catch (error) {
          json(res, 400, { ok: false, error: error.message || String(error) });
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/models") {
        const models = await listModels(url.searchParams.get("agent") || "cursor");
        json(res, 200, { ok: true, models });
        return;
      }
      if (req.method === "POST" && url.pathname === "/ask") {
        const body = await readJson(req);
        delete body.cwd;
        delete body.cursorPath;
        delete body.claudePath;
        const markup = looksLikeMarkupPacket(body.packet);
        const kind = markup ? "markup" : "ask";
        const started = Date.now();
        await journal(
          `${kind} -> agent=${body.agent || "cursor"} model=${body.model || "(default)"} packet=${String(body.packet || "").length}`
        );
        let result;
        try {
          result = await ask(body);
        } catch (error) {
          await journal(`${kind} <- FAILED after ${seconds(started)}s: ${error.message || error}`);
          throw error;
        }
        const text = typeof result === "string" ? result : result.text;
        // A markup reply is the one whose shape decides whether anything is
        // drawn, so the log says what shape it was rather than only how big.
        await journal(
          `${kind} <- ${seconds(started)}s ${markup ? shapeOfMarkupReply(text) : `chars=${String(text || "").length}`}`
        );
        json(res, 200, {
          ok: true,
          text,
          sessionId: result?.sessionId || "",
          workspace: result?.workspace || ""
        });
        return;
      }
      json(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      json(res, 500, { ok: false, error: error.message || String(error) });
    }
  });

  server.on("close", () => mirror.close());
  return { server, host, port, token: secret, mirror };
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (!originAllowed(origin) || !origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Vary", "Origin");
}

function seconds(since) {
  return Math.round((Date.now() - since) / 100) / 10;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const { server, host, port, token } = await createAgentServer();
  server.listen(port, host, () => {
    console.log(`LivePage agent host on http://${host}:${port}`);
    console.log("Loopback only. Pairing is automatic from the LivePage extension on this machine.");
    console.log(`Token length ${token.length}. Override with LIVEPAGE_AGENT_TOKEN if you need to.`);
    console.log(`Every ask is logged to ${logPath()}. LIVEPAGE_AGENT_LOG=off turns it off.`);
    console.log(`The browser's records are mirrored into ${defaultDbPath()}. LIVEPAGE_DB_PATH moves it.`);
  });
}
