export function uid(prefix = "lp") {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function shortHash(text, length = 16) {
  const hex = await sha256Hex(text);
  return hex.slice(0, length);
}

export function blockIdFromText(text) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `b_${(h >>> 0).toString(16).padStart(8, "0")}`;
}
