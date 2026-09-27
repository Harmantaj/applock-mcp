import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { privateKeyFromPassphrase } from "./vault.js";
import { retrieveKey, touchIdSupported } from "./touchid.js";
// Unlocked state lives only in this process's memory and expires automatically.
let key;
let expiresAt = 0;
let timer;
export function currentKey() {
    if (key && Date.now() < expiresAt)
        return key;
    lock();
    return undefined;
}
export function unlockedUntil() {
    return currentKey() ? new Date(expiresAt).toISOString() : undefined;
}
export function setKey(k, minutes) {
    key = k;
    expiresAt = Date.now() + minutes * 60_000;
    clearTimeout(timer);
    timer = setTimeout(lock, minutes * 60_000);
    timer.unref();
}
export function lock() {
    key?.fill(0);
    key = undefined;
    expiresAt = 0;
    clearTimeout(timer);
}
function openBrowser(url) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    execFile(cmd, args, () => { });
}
const page = (msg = "", ok = false) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Unlock AppLock</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,system-ui,sans-serif}
body{display:grid;place-items:center;min-height:100vh;margin:0;background:Canvas}
form{width:min(340px,90vw);display:grid;gap:12px;text-align:center}
input,button{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid #8884}
button{background:#0a84ff;color:#fff;border:0;cursor:pointer}
.msg{color:${ok ? "#30d158" : "#ff453a"};min-height:1.2em}
</style>
<form method="post">
<div style="font-size:40px">🔒</div>
<h1 style="font-size:20px;margin:0">Unlock AppLock</h1>
<p style="margin:0;opacity:.7">Your passphrase stays on this Mac and is never sent to the AI.</p>
${ok ? "" : `<input type="password" name="passphrase" autofocus autocomplete="current-password" placeholder="Passphrase" aria-label="Passphrase" required>
<button type="submit">Unlock</button>`}
<div class="msg" role="status">${msg}</div>
</form>`;
/**
 * Opens a one-time localhost page where the user types the passphrase, so it
 * never travels through the model. Resolves when unlocked or on timeout.
 */
export function unlockWithBrowser(cfg, timeoutMs = 120_000, launch = true) {
    const token = randomBytes(24).toString("base64url");
    let attempts = 0;
    return new Promise((resolve) => {
        let url = "";
        const server = createServer(async (req, res) => {
            const path = new URL(req.url ?? "/", "http://x").pathname.slice(1);
            const a = Buffer.from(path);
            const b = Buffer.from(token);
            if (a.length !== b.length || !timingSafeEqual(a, b)) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            res.setHeader("x-frame-options", "DENY");
            if (req.method !== "POST")
                return res.end(page());
            let raw = "";
            for await (const c of req)
                raw += c;
            const pass = new URLSearchParams(raw).get("passphrase") ?? "";
            try {
                setKey(privateKeyFromPassphrase(cfg, pass), cfg.autoLockMinutes);
                res.end(page("Unlocked. You can close this tab.", true));
                finish(true);
            }
            catch {
                attempts++;
                if (attempts >= 5) {
                    res.end(page("Too many attempts. Ask the assistant to unlock again."));
                    finish(false);
                }
                else
                    res.end(page("Wrong passphrase, try again."));
            }
        });
        const timeout = setTimeout(() => finish(false), timeoutMs);
        function finish(ok) {
            clearTimeout(timeout);
            server.close();
            server.closeAllConnections?.();
            resolve({ ok, url });
        }
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            url = `http://127.0.0.1:${addr.port}/${token}`;
            if (launch)
                openBrowser(url);
            if (process.env.APPLOCK_UNLOCK_URL_FILE) {
                import("node:fs").then((fs) => fs.writeFileSync(process.env.APPLOCK_UNLOCK_URL_FILE, url));
            }
        });
    });
}
// ---- one-time unlock links for remote clients (phone) ------------------------------
// Served by the HTTP server behind the user's own HTTPS tunnel, so the passphrase
// travels from the phone's browser straight to this computer, never through the AI.
const links = new Map();
const LINK_TTL_MS = 5 * 60_000;
export function createUnlockLink(publicUrl) {
    for (const [t, l] of links)
        if (Date.now() > l.expires)
            links.delete(t);
    const token = randomBytes(24).toString("base64url");
    links.set(token, { expires: Date.now() + LINK_TTL_MS, attempts: 0 });
    return `${publicUrl.replace(/\/$/, "")}/unlock/${token}`;
}
/** Handles GET/POST /unlock/<token>. Returns false if the token is unknown or expired. */
export async function handleUnlockLink(cfg, token, req, res) {
    const link = [...links.entries()].find(([t]) => {
        const a = Buffer.from(t);
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
    })?.[1];
    if (!link || Date.now() > link.expires)
        return false;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    if (req.method !== "POST") {
        res.end(page());
        return true;
    }
    let raw = "";
    for await (const c of req) {
        raw += c;
        if (raw.length > 10_000)
            break;
    }
    const pass = new URLSearchParams(raw).get("passphrase") ?? "";
    try {
        setKey(privateKeyFromPassphrase(cfg, pass), cfg.autoLockMinutes);
        links.delete(token);
        res.end(page("Unlocked. Go back to Claude.", true));
    }
    catch {
        link.attempts++;
        if (link.attempts >= 5) {
            links.delete(token);
            res.end(page("Too many attempts. Ask Claude for a new unlock link."));
        }
        else
            res.end(page("Wrong passphrase, try again."));
    }
    return true;
}
export async function unlockWithTouchId(cfg) {
    if (!touchIdSupported() || !cfg.touchId)
        throw new Error("Touch ID is not enabled for this vault");
    setKey(await retrieveKey("unlock your hidden chats"), cfg.autoLockMinutes);
}
