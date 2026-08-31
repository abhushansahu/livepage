import { buildVaultBundle, vaultFolderName } from "./vault-format.js";
import { getVaultMeta, saveVaultMeta } from "../storage/store.js";

export async function vaultSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function bindVaultFolder() {
  if (!(await vaultSupported())) {
    return { ok: false, reason: "picker-unavailable" };
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  const permission = await ensurePermission(handle);
  if (!permission) return { ok: false, reason: "permission-denied" };
  const meta = { id: "dir", handle, name: handle.name, boundAt: Date.now() };
  await saveVaultMeta(meta);
  return { ok: true, name: handle.name, boundAt: meta.boundAt };
}

export async function vaultStatus() {
  const meta = await getVaultMeta();
  if (!meta?.handle) return { bound: false, name: "", boundAt: 0 };
  return {
    bound: true,
    name: meta.name || meta.handle.name || "vault",
    boundAt: meta.boundAt || 0,
    writable: (await meta.handle.queryPermission?.({ mode: "readwrite" })) === "granted"
  };
}

export async function writeVault(pages, settings) {
  const handle = await usableHandle();
  if (!handle) return { ok: false, reason: "not-bound" };
  const bundle = buildVaultBundle(pages, settings);
  const root = await handle.getDirectoryHandle(bundle.folder, { create: true });
  for (const file of bundle.files) {
    await writePath(root, file.path, file.content);
  }
  return {
    ok: true,
    folder: bundle.folder,
    files: bundle.files.length,
    name: handle.name
  };
}

export async function readVaultConfig(settings) {
  const handle = await usableHandle();
  if (!handle) return null;
  try {
    const root = await handle.getDirectoryHandle(vaultFolderName(settings), { create: false });
    const file = await root.getFileHandle("config.json");
    const text = await (await file.getFile()).text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function usableHandle() {
  const meta = await getVaultMeta();
  if (!meta?.handle) return null;
  if (await ensurePermission(meta.handle)) return meta.handle;
  return null;
}

async function ensurePermission(handle) {
  if (!handle?.queryPermission) return true;
  const current = await handle.queryPermission({ mode: "readwrite" });
  if (current === "granted") return true;
  if (!handle.requestPermission) return false;
  const next = await handle.requestPermission({ mode: "readwrite" });
  return next === "granted";
}

async function writePath(root, parts, contents) {
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const file = await dir.getFileHandle(parts.at(-1), { create: true });
  const writable = await file.createWritable();
  await writable.write(contents);
  await writable.close();
}
