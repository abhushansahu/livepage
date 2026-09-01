import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_CURSOR_MODEL = "composer-2.5";
const DEFAULT_CLAUDE_MODEL = "sonnet";
const workspaces = new Map();

export async function handleAsk(body = {}) {
  const agent = body.agent === "claude-code" ? "claude-code" : "cursor";
  const packet = String(body.packet || "").trim();
  if (!packet) throw new Error("Missing packet");
  const resumeId = String(body.resumeId || "").trim();
  const workspace = await prepareWorkspace(packet, resumeId);
  const result =
    agent === "claude-code"
      ? await askClaudeCode({
          packet,
          workspace,
          model: body.model || DEFAULT_CLAUDE_MODEL,
          resumeId
        })
      : await askCursor({
          workspace,
          model: body.model || DEFAULT_CURSOR_MODEL,
          resumeId
        });
  if (result?.sessionId) workspaces.set(result.sessionId, workspace);
  return result;
}

export async function probeClis(settings = {}) {
  const cursor = await resolveBin(settings.cursorPath || process.env.LIVEPAGE_CURSOR_BIN || "agent", [
    "agent",
    "cursor-agent"
  ]);
  const claude = await resolveBin(settings.claudePath || process.env.LIVEPAGE_CLAUDE_BIN || "claude", ["claude"]);
  return {
    cursor: cursor.path,
    cursorOk: cursor.ok,
    claude: claude.path,
    claudeOk: claude.ok
  };
}

export async function listModels(agent) {
  if (agent === "claude-code") {
    return [
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }
    ];
  }
  return [
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "auto", label: "Auto" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "claude-4.6-opus", label: "Claude 4.6 Opus" },
    { id: "claude-4.6-sonnet", label: "Claude 4.6 Sonnet" }
  ];
}

async function askCursor({ workspace, model, resumeId }) {
  const resolved = await resolveBin(process.env.LIVEPAGE_CURSOR_BIN || "agent", ["agent", "cursor-agent"]);
  if (!resolved.ok) {
    throw new Error(
      `Cursor CLI not found (${resolved.path}). Install the Cursor agent CLI and keep it on PATH (usually ~/.local/bin/agent).`
    );
  }
  const args = [
    "-p",
    "--mode",
    "ask",
    "--trust",
    "--output-format",
    "json",
    "--workspace",
    workspace
  ];
  if (resumeId) args.push("--resume", resumeId);
  if (model) args.push("--model", model);
  args.push(
    "Read packet.md in this workspace. It is a LivePage packet about a webpage the user highlighted. Continue the conversation in that packet. Answer STRICTLY the latest user ask. Reply with the answer only. Do not edit files."
  );
  let output = await runProcess(resolved.path, args, workspace);
  let parsed = parseAgentOutput(output);
  if (!parsed.text) {
    const textArgs = args.map((arg) => (arg === "json" ? "text" : arg));
    output = await runProcess(resolved.path, textArgs, workspace);
    parsed = parseAgentOutput(output);
  }
  if (!parsed.text) {
    throw new Error("Cursor agent returned an empty reply. Are you logged in (`agent login`)?");
  }
  return { ...parsed, workspace };
}

async function askClaudeCode({ packet, workspace, model, resumeId }) {
  const resolved = await resolveBin(process.env.LIVEPAGE_CLAUDE_BIN || "claude", ["claude"]);
  if (!resolved.ok) {
    throw new Error(
      `Claude Code not found (${resolved.path}). Install the claude CLI and keep it on PATH.`
    );
  }
  const args = [
    "-p",
    packet.length < 80000
      ? packet
      : "Read packet.md in this directory. Continue the conversation. Answer STRICTLY the latest user ask. Reply with the answer only. Do not edit files.",
    "--output-format",
    "json",
    "--max-turns",
    resumeId ? "4" : "1"
  ];
  if (resumeId) args.push("--resume", resumeId);
  if (packet.length >= 80000) args.push("--add-dir", workspace);
  if (model) args.push("--model", model);
  const output = await runProcess(resolved.path, args, workspace);
  const parsed = parseAgentOutput(output);
  if (!parsed.text) {
    throw new Error("Claude Code returned an empty reply. Are you logged in (`claude`)?");
  }
  return { ...parsed, workspace };
}

export function parseAgentOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) return { text: "", sessionId: "" };
  const candidates = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        candidates.push(JSON.parse(trimmed));
      } catch {
        /* skip non-json line */
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const row = candidates[i];
    const extracted = textFromAgentJson(row);
    if (extracted) {
      return {
        text: extracted,
        sessionId: sessionIdFromAgentJson(row) || sessionIdFromAgentJson(candidates[0])
      };
    }
  }
  if (looksLikeJson(text)) return { text: "", sessionId: "" };
  return { text, sessionId: "" };
}

function textFromAgentJson(row) {
  if (!row || typeof row !== "object") return "";
  if (typeof row.result === "string" && row.result.trim()) return row.result.trim();
  if (typeof row.text === "string" && row.text.trim()) return row.text.trim();
  const content = row.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (joined) return joined;
  }
  return "";
}

function sessionIdFromAgentJson(row) {
  if (!row || typeof row !== "object") return "";
  return String(row.session_id || row.sessionId || row.chat_id || row.chatId || "").trim();
}

function looksLikeJson(text) {
  const s = text.trim();
  return s.startsWith("{") || s.startsWith("[");
}

export async function prepareWorkspace(packet, resumeId = "") {
  const existing = resumeId ? workspaces.get(resumeId) : "";
  const dir = existing || join(tmpdir(), `livepage-agent-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "packet.md"), packet, "utf8");
  return dir;
}

async function resolveBin(preferred, names) {
  const home = homedir();
  const extras = [
    join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  const ordered = [];
  if (preferred && (preferred.includes("/") || preferred.startsWith("."))) {
    ordered.push(preferred);
  }
  const pathDirs = extraPath().split(":").filter(Boolean);
  for (const name of names) {
    for (const dir of pathDirs) {
      ordered.push(join(dir, name));
    }
  }
  if (preferred && !preferred.includes("/")) ordered.unshift(...extras.map((dir) => join(dir, preferred)));
  const seen = new Set();
  for (const candidate of ordered) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!candidate.includes("/")) continue;
    try {
      await access(candidate, constants.X_OK);
      return { ok: true, path: candidate };
    } catch {
      /* keep looking */
    }
  }
  return { ok: false, path: preferred || names[0] };
}

function extraPath() {
  const home = homedir();
  const extras = [
    join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  return [...extras, process.env.PATH || ""].join(":");
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PATH: extraPath(), HOME: homedir() },
      cwd: cwd || homedir(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      const text = out.trim();
      if (code !== 0 && !text) {
        reject(new Error(err.trim() || `${command} exited ${code}`));
        return;
      }
      resolve(text || err.trim());
    });
  });
}
