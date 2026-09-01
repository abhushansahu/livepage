import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAsk, listModels, probeClis } from "./ask.mjs";
import {
  DEFAULT_PORT,
  bearerToken,
  hostHeaderAllowed,
  listenAddress,
  loadOrCreateToken,
  originAllowed,
  tokenMatches
} from "./guard.mjs";

export async function createAgentServer({ token, ask = handleAsk } = {}) {
  const port = Number(process.env.LIVEPAGE_AGENT_PORT || DEFAULT_PORT);
  const host = listenAddress();
  const secret = token || (await loadOrCreateToken());

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
        const result = await ask(body);
        const text = typeof result === "string" ? result : result.text;
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

  return { server, host, port, token: secret };
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (!originAllowed(origin) || !origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Vary", "Origin");
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
  });
}
