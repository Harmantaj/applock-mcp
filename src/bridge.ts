import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BRIDGE_PORT, bridgeQueuePath, bridgeStatePath } from "./paths.js";
import { VERSION } from "./version.js";
import { loadConfig, storeWebChat } from "./vault.js";

// The browser extension cannot see the file system, so the MCP server exposes a
// tiny localhost API on a fixed port. Several MCP processes may run at once
// (one per client); whichever grabs the port serves it, and all of them share
// state through two files in ~/.applock.

export interface BrowserChat {
  site: string;
  id: string;
  title: string;
  url?: string;
}

export interface BridgeCommand {
  id: string;
  action: "lock" | "relock" | "phoneHiding" | "vaultCopy";
  /** lock: also archive on the provider so it leaves the phone apps' lists. */
  archive?: boolean;
  /** phoneHiding: turn "Hide on your phone too" on or off. */
  on?: boolean;
  /** phoneHiding: also archive chats that are already locked. */
  applyToLocked?: boolean;
  site?: string;
  chatId?: string;
  current?: boolean;
  createdAt: string;
}

export interface BridgeState {
  extensionOrigin?: string;
  lastSeen?: string;
  active?: BrowserChat | null;
  chats?: BrowserChat[];
  lockedCount?: number;
  phone?: { hiding: boolean; archived: number; pending: number; chatgptLocked: number };
  results?: Record<string, { ok: boolean; chat?: BrowserChat; error?: string; detail?: any; at: string }>;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export const readState = () => readJson<BridgeState>(bridgeStatePath(), {});
const writeState = (s: BridgeState) => writeJson(bridgeStatePath(), s);

export function enqueue(cmd: Omit<BridgeCommand, "id" | "createdAt">): BridgeCommand {
  const full: BridgeCommand = { ...cmd, id: randomUUID(), createdAt: new Date().toISOString() };
  const q = readJson<BridgeCommand[]>(bridgeQueuePath(), []);
  q.push(full);
  writeJson(bridgeQueuePath(), q);
  return full;
}

// Chrome wakes the extension at most every 30 s when no chat tab is open, so
// anything shorter than that makes a healthy connection look dropped.
export function extensionConnected(maxAgeMs = 75_000): boolean {
  const s = readState();
  return !!s.lastSeen && Date.now() - Date.parse(s.lastSeen) < maxAgeMs;
}

/** Waits for the extension to acknowledge a command. */
export async function waitForResult(cmdId: string, timeoutMs = 45_000): Promise<{ ok: boolean; chat?: BrowserChat; error?: string; detail?: any; at: string } | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = readState().results?.[cmdId];
    if (r) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: unknown, origin?: string) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const EXT_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+$/i;

export async function handleBridge(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin ?? "";
  const reqPath = new URL(req.url ?? "/", "http://x").pathname;
  // Version handover between AppLock processes on this computer. Browsers always
  // send Origin on POST, so web pages can't trigger it.
  if (reqPath === "/applock/version" && req.method === "GET") return send(res, 200, { app: "applock-mcp", version: VERSION });
  if (reqPath === "/applock/yield" && req.method === "POST" && !origin) {
    const b = await body(req).catch(() => ({}));
    if (newer(String(b.version ?? ""), VERSION)) {
      send(res, 200, { yielded: true });
      onYield?.();
      return;
    }
    return send(res, 409, { yielded: false, version: VERSION });
  }
  // Web pages can't forge Origin, so only browser extensions get through.
  // The first extension to connect is pinned; `applock-mcp bridge-reset` clears it.
  if (!EXT_ORIGIN.test(origin)) return send(res, 403, { error: "Only the AppLock extension may use this endpoint" });
  const state = readState();
  if (state.extensionOrigin && state.extensionOrigin !== origin)
    return send(res, 403, { error: "A different extension is paired. Run `applock-mcp bridge-reset` to re-pair." });

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  const path = new URL(req.url ?? "/", "http://x").pathname;
  const now = new Date().toISOString();
  if (req.method === "POST" && path === "/bridge/sync") {
    const b = await body(req);
    const next: BridgeState = { ...state, extensionOrigin: origin, lastSeen: now };
    if ("active" in b) next.active = b.active ?? null;
    if (Array.isArray(b.chats)) next.chats = b.chats.slice(0, 500);
    if (typeof b.lockedCount === "number") next.lockedCount = b.lockedCount;
    if (b.phone && typeof b.phone === "object") next.phone = b.phone;
    if (Array.isArray(b.results)) {
      next.results = { ...(state.results ?? {}) };
      for (const r of b.results) next.results[r.id] = { ok: !!r.ok, chat: r.chat, error: r.error, detail: r.detail, at: now };
      // Keep the results map small.
      const keys = Object.keys(next.results);
      for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete next.results[k];
    }
    writeState(next);
    const commands = readJson<BridgeCommand[]>(bridgeQueuePath(), []);
    if (commands.length) writeJson(bridgeQueuePath(), []);
    return send(res, 200, { commands }, origin);
  }
  if (req.method === "POST" && path === "/bridge/vault") {
    // The extension hands over a chat transcript before deleting it at the provider.
    // Sealed with the public key, so this works while the vault is locked.
    const cfg = loadConfig();
    if (!cfg) return send(res, 409, { error: "AppLock on this computer isn't set up (run applock-mcp setup)" }, origin);
    const b = await body(req, 25_000_000);
    const meta = storeWebChat(cfg, b);
    writeState({ ...readState(), extensionOrigin: origin, lastSeen: now });
    return send(res, 200, { vaultId: meta.vaultId, messages: b.messages.length }, origin);
  }
  if (req.method === "GET" && path === "/bridge/ping") return send(res, 200, { ok: true, app: "applock-mcp" }, origin);
  send(res, 404, { error: "Not found" }, origin);
}

export function resetBridge() {
  writeState({});
  writeJson(bridgeQueuePath(), []);
}

/** True if version a is newer than b ("0.5.2" > "0.5.1"). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

let onYield: (() => void) | undefined;

function listenOnce(): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handleBridge(req, res).catch((e) => send(res, 400, { error: String(e?.message ?? e) }));
    });
    server.once("error", () => resolve(undefined));
    server.listen(BRIDGE_PORT, "127.0.0.1", () => {
      server.unref();
      resolve(server);
    });
  });
}

async function ownerVersion(): Promise<string | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/applock/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? (await r.json()).version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Owns the bridge port when possible. Several AppLock processes may run (one per
 * AI client plus the background service); the newest version wins: an older
 * owner is asked to hand over, and a process that can't bind keeps retrying so
 * the bridge comes back if its owner exits.
 */
export async function startBridge(retryMs = 15_000): Promise<Server | undefined> {
  let server = await listenOnce();
  if (!server) {
    const theirs = await ownerVersion();
    if (theirs && newer(VERSION, theirs)) {
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/applock/yield`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: VERSION }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      server = await listenOnce();
    }
  }
  if (server) {
    onYield = () => {
      server!.close();
      server!.closeAllConnections?.();
      scheduleRetry(retryMs);
    };
    return server;
  }
  scheduleRetry(retryMs);
  return undefined;
}

let retryTimer: NodeJS.Timeout | undefined;
function scheduleRetry(ms: number) {
  if (ms <= 0) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    // Only take over a free port or an older owner; never fight an equal or newer one.
    const theirs = await ownerVersion();
    if (!theirs || newer(VERSION, theirs)) await startBridge(ms);
    else scheduleRetry(ms);
  }, ms);
  retryTimer.unref();
}
