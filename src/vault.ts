import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { newKdfParams, newKeyPair, open, passphraseKey, seal, unwrap, wrap, type KdfParams } from "./crypto.js";
import { applockHome, configPath, pendingPath, vaultDir } from "./paths.js";
import type { Session } from "./sources.js";

export interface Config {
  version: 1;
  publicKey: string;
  kdf: KdfParams;
  wrappedPrivateKey: string;
  touchId: boolean;
  autoLockMinutes: number;
  createdAt: string;
}

export type HiddenSource = "claude-code" | "antigravity" | "browser";

export interface HiddenMeta {
  vaultId: string;
  source: HiddenSource;
  id: string;
  title: string;
  project?: string;
  site?: string;
  url?: string;
  paths: string[];
  sizeBytes: number;
  hiddenAt: string;
}

interface Payload {
  files: { path: string; mode: number; mtimeMs: number; data: string }[];
  dirs: string[];
}

function writeAtomic(path: string, data: Buffer | string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export function loadConfig(): Config | undefined {
  if (!existsSync(configPath())) return undefined;
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

export function saveConfig(cfg: Config) {
  writeAtomic(configPath(), JSON.stringify(cfg, null, 2));
}

export function createVault(passphrase: string, opts: { touchId?: boolean; autoLockMinutes?: number } = {}) {
  if (passphrase.length < 6) throw new Error("Passphrase must be at least 6 characters");
  if (loadConfig()) throw new Error(`A vault already exists at ${applockHome()}`);
  const { publicKey, privateKey } = newKeyPair();
  const kdf = newKdfParams();
  const cfg: Config = {
    version: 1,
    publicKey,
    kdf,
    wrappedPrivateKey: wrap(privateKey, passphraseKey(passphrase, kdf)),
    touchId: !!opts.touchId,
    autoLockMinutes: opts.autoLockMinutes ?? 10,
    createdAt: new Date().toISOString(),
  };
  saveConfig(cfg);
  mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
  return { cfg, privateKey };
}

/** Returns the private key, or throws "Wrong passphrase". */
export function privateKeyFromPassphrase(cfg: Config, passphrase: string): Buffer {
  try {
    return unwrap(cfg.wrappedPrivateKey, passphraseKey(passphrase, cfg.kdf));
  } catch {
    throw new Error("Wrong passphrase");
  }
}

export function changePassphrase(cfg: Config, privateKey: Buffer, next: string) {
  if (next.length < 6) throw new Error("Passphrase must be at least 6 characters");
  const kdf = newKdfParams();
  saveConfig({ ...cfg, kdf, wrappedPrivateKey: wrap(privateKey, passphraseKey(next, kdf)) });
}

// ---- hiding -----------------------------------------------------------------

function collect(path: string, payload: Payload) {
  const st = statSync(path);
  if (st.isDirectory()) {
    payload.dirs.push(path);
    for (const name of readdirSync(path)) collect(join(path, name), payload);
  } else if (st.isFile()) {
    payload.files.push({ path, mode: st.mode & 0o777, mtimeMs: st.mtimeMs, data: readFileSync(path).toString("base64") });
  }
}

function metaFile(vaultId: string) {
  return join(vaultDir(), `${vaultId}.meta.alk`);
}
function dataFile(vaultId: string) {
  return join(vaultDir(), `${vaultId}.data.alk`);
}

/** Encrypts a session's files into the vault and removes the originals. Needs only the public key. */
export function hideSession(cfg: Config, session: Session): HiddenMeta {
  const payload: Payload = { files: [], dirs: [] };
  for (const p of session.paths) if (existsSync(p)) collect(p, payload);
  if (payload.files.length === 0) throw new Error(`Nothing on disk for session ${session.id}`);
  const vaultId = randomUUID();
  const meta: HiddenMeta = {
    vaultId,
    source: session.source,
    id: session.id,
    title: session.title,
    project: session.project,
    paths: session.paths,
    sizeBytes: payload.files.reduce((n, f) => n + Buffer.byteLength(f.data, "base64"), 0),
    hiddenAt: new Date().toISOString(),
  };
  const sealedData = seal(gzipSync(Buffer.from(JSON.stringify(payload))), cfg.publicKey);
  writeAtomic(dataFile(vaultId), sealedData);
  writeAtomic(metaFile(vaultId), seal(Buffer.from(JSON.stringify(meta)), cfg.publicKey));
  // Only delete originals once both sealed files are safely on disk.
  if (readFileSync(dataFile(vaultId)).length !== sealedData.length) throw new Error("Vault write verification failed");
  for (const p of session.paths) rmSync(p, { recursive: true, force: true });
  return meta;
}

/** Records a browser chat lock (the extension does the hiding; this keeps a private log). */
export function recordBrowserLock(cfg: Config, chat: { site: string; id: string; title: string; url?: string }): HiddenMeta {
  const meta: HiddenMeta = {
    vaultId: randomUUID(),
    source: "browser",
    id: chat.id,
    title: chat.title,
    site: chat.site,
    url: chat.url,
    paths: [],
    sizeBytes: 0,
    hiddenAt: new Date().toISOString(),
  };
  writeAtomic(metaFile(meta.vaultId), seal(Buffer.from(JSON.stringify(meta)), cfg.publicKey));
  return meta;
}

export function hiddenCount(): number {
  if (!existsSync(vaultDir())) return 0;
  return readdirSync(vaultDir()).filter((f) => f.endsWith(".meta.alk")).length;
}

export function listHidden(privateKey: Buffer): HiddenMeta[] {
  if (!existsSync(vaultDir())) return [];
  return readdirSync(vaultDir())
    .filter((f) => f.endsWith(".meta.alk"))
    .map((f) => JSON.parse(open(readFileSync(join(vaultDir(), f)), privateKey).toString("utf8")) as HiddenMeta)
    .sort((a, b) => b.hiddenAt.localeCompare(a.hiddenAt));
}

export function findHidden(privateKey: Buffer, ref: string): HiddenMeta {
  const all = listHidden(privateKey);
  const hit =
    all.find((m) => m.vaultId === ref || m.id === ref) ??
    (ref.length >= 6 ? all.find((m) => m.vaultId.startsWith(ref) || m.id.startsWith(ref)) : undefined);
  if (!hit) throw new Error(`No hidden item matches "${ref}"`);
  return hit;
}

function loadPayload(privateKey: Buffer, vaultId: string): Payload {
  return JSON.parse(gunzipSync(open(readFileSync(dataFile(vaultId)), privateKey)).toString("utf8"));
}

export function restoreHidden(privateKey: Buffer, meta: HiddenMeta): string[] {
  if (meta.source !== "browser") {
    const payload = loadPayload(privateKey, meta.vaultId);
    // A client may have appended a few lines after the session was hidden; those
    // go after the restored transcript. Any other existing file is a real conflict.
    const clash = payload.files.find((f) => existsSync(f.path) && !f.path.endsWith(".jsonl"));
    if (clash) throw new Error(`Refusing to overwrite existing file ${clash.path}`);
    for (const d of payload.dirs) mkdirSync(d, { recursive: true });
    for (const f of payload.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      const data = Buffer.from(f.data, "base64");
      let merged = data;
      if (existsSync(f.path)) {
        // Whichever copy was written first goes first.
        const onDisk = readFileSync(f.path);
        merged = statSync(f.path).mtimeMs > f.mtimeMs ? Buffer.concat([data, onDisk]) : Buffer.concat([onDisk, data]);
        f.mtimeMs = Math.max(f.mtimeMs, statSync(f.path).mtimeMs);
      }
      writeFileSync(f.path, merged, { mode: f.mode });
      const t = new Date(f.mtimeMs);
      utimesSync(f.path, t, t);
    }
    rmSync(dataFile(meta.vaultId), { force: true });
  }
  rmSync(metaFile(meta.vaultId), { force: true });
  return meta.paths;
}

/** Plain-text transcript of a hidden local session, for reading while unlocked. */
export function readHidden(privateKey: Buffer, meta: HiddenMeta, maxChars = 20000): string {
  if (meta.source === "browser") return `Browser chat on ${meta.site}: ${meta.url ?? meta.id}`;
  const payload = loadPayload(privateKey, meta.vaultId);
  const parts: string[] = [];
  for (const f of payload.files) {
    const buf = Buffer.from(f.data, "base64");
    if (f.path.endsWith(".jsonl")) {
      for (const line of buf.toString("utf8").split("\n")) {
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if ((rec.type !== "user" && rec.type !== "assistant") || rec.isMeta || rec.isSidechain) continue;
        const c = rec.message?.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n")
              : "";
        if (text && !text.startsWith("<")) parts.push(`${rec.type === "user" ? "User" : "Assistant"}: ${text}`);
      }
    } else if (f.path.endsWith(".md") || f.path.endsWith(".pbtxt")) {
      parts.push(`--- ${f.path.split("/").pop()} ---\n${buf.toString("utf8")}`);
    }
  }
  const text = parts.join("\n\n") || "(No readable text; the transcript is in a binary format. Restore it to open it in the app.)";
  return text.length > maxChars ? text.slice(0, maxChars) + `\n\n… truncated (${text.length} chars total)` : text;
}

// ---- deferred hides (the running Claude Code session) ------------------------

export interface Pending {
  source: "claude-code";
  id: string;
  requestedAt: string;
}

export function loadPending(): Pending[] {
  try {
    return JSON.parse(readFileSync(pendingPath(), "utf8"));
  } catch {
    return [];
  }
}

export function savePending(list: Pending[]) {
  writeAtomic(pendingPath(), JSON.stringify(list, null, 2));
}
