import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 17321;
export const DEFAULT_LISTEN = "127.0.0.1";

export function listenAddress() {
  const requested = process.env.LIVEPAGE_AGENT_HOST;
  if (!requested) return DEFAULT_LISTEN;
  if (isLoopbackHost(requested)) {
    return requested.toLowerCase() === "localhost" ? DEFAULT_LISTEN : requested;
  }
  throw new Error(
    `Refusing to bind the agent host to ${requested}. Loopback only (127.0.0.1 or ::1).`
  );
}

export function isLoopbackHost(host) {
  const h = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "0:0:0:0:0:0:0:1";
}

export function hostHeaderAllowed(header) {
  const raw = String(header || "").split(",")[0].trim().toLowerCase();
  if (!raw) return false;
  let name = raw;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return false;
    name = raw.slice(1, end);
  } else if (raw.includes(":")) {
    name = raw.slice(0, raw.lastIndexOf(":"));
  }
  return isLoopbackHost(name);
}

/** Pages on the public web always send an http(s) Origin. Extension SW and curl do not. */
export function originAllowed(origin) {
  if (origin == null || origin === "") return true;
  return /^chrome-extension:\/\//i.test(String(origin));
}

export function bearerToken(header) {
  const value = String(header || "");
  const match = value.match(/^Bearer\s+(\S+)/i);
  return match ? match[1] : "";
}

export function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

export function tokenFilePath() {
  return join(homedir(), ".livepage", "agent-host.json");
}

export async function loadOrCreateToken() {
  const fromEnv = String(process.env.LIVEPAGE_AGENT_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const file = tokenFilePath();
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const token = String(raw?.token || "").trim();
    if (token) return token;
  } catch {
    /* create below */
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(join(homedir(), ".livepage"), { recursive: true });
  await writeFile(file, `${JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return token;
}
