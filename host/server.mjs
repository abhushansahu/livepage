import http from "node:http";
import { handleAsk, listModels, probeClis } from "./ask.mjs";

const PORT = Number(process.env.LIVEPAGE_AGENT_PORT || 17321);
const HOST = process.env.LIVEPAGE_AGENT_HOST || "127.0.0.1";

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const clis = await probeClis();
      json(res, 200, { ok: true, ...clis });
      return;
    }
    if (req.method === "GET" && url.pathname === "/models") {
      const models = await listModels(url.searchParams.get("agent") || "cursor");
      json(res, 200, { ok: true, models });
      return;
    }
    if (req.method === "POST" && url.pathname === "/ask") {
      const body = await readJson(req);
      const result = await handleAsk(body);
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

server.listen(PORT, HOST, () => {
  console.log(`LivePage agent host on http://${HOST}:${PORT}`);
});

function applyCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "content-type");
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
