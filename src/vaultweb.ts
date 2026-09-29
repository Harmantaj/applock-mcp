import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applockHome } from "./paths.js";
import { currentKey, lock, setKey, unlockedUntil } from "./unlock.js";
import { findHidden, listHidden, privateKeyFromPassphrase, readHidden, readWebChat, type Config } from "./vault.js";

// AppLock Vault: a small web app for phones, served by the HTTP server behind the
// user's own HTTPS tunnel at /vault/<secret>/. It lists everything in the vault and
// shows vaulted chats. Add it to the Home Screen; iCloud Keychain fills the
// passphrase after Face ID.

export function vaultSecret(): string {
  const p = join(applockHome(), "vault-secret");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const s = randomBytes(18).toString("base64url");
  mkdirSync(applockHome(), { recursive: true, mode: 0o700 });
  writeFileSync(p, s, { mode: 0o600 });
  return s;
}

const sessions = new Map<string, number>();
let failures = 0;
let lockedOutUntil = 0;

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: IncomingMessage): string | undefined {
  return req.headers.cookie?.match(/(?:^|;\s*)al_vault=([A-Za-z0-9_-]+)/)?.[1];
}

function signedIn(req: IncomingMessage): boolean {
  const t = cookieToken(req);
  if (!t || !currentKey()) return false;
  for (const [tok, exp] of sessions) {
    if (Date.now() > exp) sessions.delete(tok);
    else if (sameText(tok, t)) return true;
  }
  return false;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 10_000) break;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

const ICON = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon-180.png");

/** Handles everything under /vault/<secret>/. Returns false if the path isn't ours. */
export async function handleVaultWeb(cfg: Config | undefined, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  const prefix = `/vault/${vaultSecret()}`;
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return false;
  const sub = url.pathname.slice(prefix.length) || "/";
  const cookiePath = `Path=${prefix}; HttpOnly; Secure; SameSite=Strict`;
  const common = { "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

  if (sub === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...common, "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'" });
    res.end(PAGE(prefix));
    return true;
  }
  if (sub === "/manifest.webmanifest") {
    res.writeHead(200, { "content-type": "application/manifest+json" });
    res.end(JSON.stringify({ name: "AppLock Vault", short_name: "Vault", start_url: `${prefix}/`, scope: `${prefix}/`, display: "standalone", background_color: "#10151e", theme_color: "#10151e", icons: [{ src: `${prefix}/icon.png`, sizes: "180x180", type: "image/png" }] }));
    return true;
  }
  if (sub === "/icon.png") {
    if (!existsSync(ICON)) return void res.writeHead(404).end(), true;
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
    res.end(readFileSync(ICON));
    return true;
  }
  if (!cfg) return json(res, 409, { error: "AppLock isn't set up on the computer." }), true;

  if (sub === "/api/login" && req.method === "POST") {
    if (Date.now() < lockedOutUntil) return json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil((lockedOutUntil - Date.now()) / 60000)} min.` }), true;
    const { passphrase = "" } = await readBody(req);
    try {
      setKey(privateKeyFromPassphrase(cfg, String(passphrase)), cfg.autoLockMinutes);
    } catch {
      failures++;
      if (failures >= 5) {
        lockedOutUntil = Date.now() + 5 * 60_000;
        failures = 0;
      }
      return json(res, 401, { error: "Wrong passphrase." }), true;
    }
    failures = 0;
    const token = randomBytes(24).toString("base64url");
    sessions.set(token, Date.now() + cfg.autoLockMinutes * 60_000);
    return json(res, 200, { ok: true, until: unlockedUntil() }, { "set-cookie": `al_vault=${token}; ${cookiePath}; Max-Age=${cfg.autoLockMinutes * 60}` }), true;
  }
  if (sub === "/api/logout" && req.method === "POST") {
    sessions.clear();
    lock();
    return json(res, 200, { ok: true }, { "set-cookie": `al_vault=; ${cookiePath}; Max-Age=0` }), true;
  }
  if (!signedIn(req)) return json(res, 401, { error: "Locked" }), true;
  const key = currentKey()!;

  if (sub === "/api/items" && req.method === "GET") {
    const items = listHidden(key).map((m) => ({
      id: m.vaultId,
      title: m.title,
      source: m.source,
      site: m.site,
      hiddenAt: m.hiddenAt,
      readable: m.source !== "browser" || !!m.vaulted,
      vaulted: !!m.vaulted,
    }));
    return json(res, 200, { items, until: unlockedUntil() }), true;
  }
  const item = sub.match(/^\/api\/items\/([0-9a-f-]{36})$/);
  if (item && req.method === "GET") {
    const meta = findHidden(key, item[1]);
    if (meta.vaulted) {
      const web = readWebChat(key, meta);
      return json(res, 200, { title: web.title, site: web.site, messages: web.messages }), true;
    }
    return json(res, 200, { title: meta.title, site: meta.source, text: readHidden(key, meta, 200_000) }), true;
  }
  json(res, 404, { error: "Not found" });
  return true;
}

const PAGE = (prefix: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Vault">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#10151e">
<link rel="manifest" href="${prefix}/manifest.webmanifest">
<link rel="apple-touch-icon" href="${prefix}/icon.png">
<title>AppLock Vault</title>
<style>
:root{--bg:#f2f4f7;--card:#fff;--ink:#141b26;--muted:#5b6678;--line:#dde3ea;--accent:#3a3f9e;--me:#3a3f9e;--me-ink:#fff;--them:#fff;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#10151e;--card:#182030;--ink:#e8edf4;--muted:#9aa6b8;--line:#2a3548;--accent:#8f95ff;--me:#4a50b8;--them:#1e2838}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:640px;margin:0 auto;padding:calc(16px + env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom))}
header{display:flex;align-items:center;gap:10px;margin-bottom:16px}h1{font-size:22px;margin:0;flex:1}
button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:12px 16px;background:var(--accent);color:#fff;touch-action:manipulation}
button.ghost{background:transparent;color:var(--accent);padding:8px}
input{font:inherit;width:100%;padding:14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
form{display:grid;gap:12px;margin-top:20vh;text-align:center}
.err{color:#d70015;min-height:1.4em}
ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
li button{width:100%;text-align:left;background:var(--card);color:var(--ink);font-weight:500;display:flex;gap:10px;align-items:center}
li .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:12px;color:var(--muted);font-weight:600}
.msgs{display:grid;gap:10px}.m{padding:10px 14px;border-radius:16px;max-width:88%;white-space:pre-wrap;overflow-wrap:anywhere}
.m.user{justify-self:end;background:var(--me);color:var(--me-ink);border-bottom-right-radius:4px}
.m.assistant,.m.system,.m.tool{justify-self:start;background:var(--them);border-bottom-left-radius:4px}
.muted{color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);padding:12px;border-radius:12px}
</style></head>
<body><main id="app"></main>
<script>
const P = ${JSON.stringify(prefix)};
const app = document.getElementById("app");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const api = (p, o) => fetch(P + p, { credentials: "same-origin", ...o }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const siteName = (s) => ({ chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", "claude-code": "Claude Code", antigravity: "Antigravity" })[s] || s || "";

function login(msg = "") {
  app.innerHTML = '<form id="f" autocomplete="on"><div style="font-size:48px">🔒</div><h1>AppLock Vault</h1>' +
    '<p class="muted">Your passphrase goes straight to your computer.</p>' +
    '<input type="text" name="username" autocomplete="username" value="AppLock" hidden aria-hidden="true">' +
    '<input type="password" name="password" id="pw" autocomplete="current-password" placeholder="Passphrase" aria-label="Passphrase" required>' +
    '<button type="submit">Unlock</button><div class="err" role="alert">' + esc(msg) + '</div></form>';
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const r = await api("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: document.getElementById("pw").value }) });
    if (r.status === 200) list(); else login(r.body.error || "Couldn't unlock.");
  };
}

async function list() {
  const r = await api("/api/items");
  if (r.status === 401) return login();
  const items = r.body.items || [];
  app.innerHTML = '<header><h1>Vault</h1><button class="ghost" id="lock">Lock</button></header>' +
    (items.length ? '<ul>' + items.map((i) => '<li><button data-id="' + esc(i.id) + '"' + (i.readable ? "" : " disabled") + '><span class="t">' + esc(i.title) + '</span><span class="tag">' + esc(siteName(i.site || i.source)) + (i.readable ? "" : " · locked in browser") + '</span></button></li>').join("") + '</ul>'
      : '<p class="muted">Nothing here yet. Use “Move to vault” in the AppLock extension, or hide a Claude Code session.</p>');
  document.getElementById("lock").onclick = async () => { await api("/api/logout", { method: "POST" }); login(); };
  app.querySelectorAll("li button[data-id]").forEach((b) => (b.onclick = () => show(b.dataset.id)));
}

async function show(id) {
  const r = await api("/api/items/" + id);
  if (r.status === 401) return login();
  const b = r.body;
  const body = b.messages
    ? '<div class="msgs">' + b.messages.map((m) => '<div class="m ' + esc(m.role) + '">' + esc(m.text) + '</div>').join("") + '</div>'
    : '<pre>' + esc(b.text || "") + '</pre>';
  app.innerHTML = '<header><button class="ghost" id="back">‹ Vault</button><h1 style="font-size:17px">' + esc(b.title) + '</h1></header>' + body;
  document.getElementById("back").onclick = list;
  scrollTo(0, 0);
}
list();
</script></body></html>`;
