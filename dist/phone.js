import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
// Helpers for `applock-mcp install phone`: find Tailscale, pick a safe local
// port, and pick a Funnel HTTPS port that isn't already serving something else.
export const APP_ID = "applock-mcp";
export const FUNNEL_PORTS = [443, 8443, 10000]; // the only ports Tailscale Funnel allows
export function tailscaleBin() {
    if (process.env.APPLOCK_TAILSCALE)
        return process.env.APPLOCK_TAILSCALE;
    try {
        const p = execFileSync("/bin/sh", ["-c", "command -v tailscale"], { stdio: "pipe" }).toString().trim();
        if (p)
            return p;
    }
    catch { }
    const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    return existsSync(mac) ? mac : undefined;
}
export function tailscaleStatus(bin) {
    try {
        const s = JSON.parse(execFileSync(bin, ["status", "--json"], { stdio: "pipe", timeout: 15000 }).toString());
        return { running: s.BackendState === "Running", host: s.Self?.DNSName?.replace(/\.$/, "") || undefined };
    }
    catch {
        return { running: false };
    }
}
export function funnelStatus(bin) {
    try {
        return JSON.parse(execFileSync(bin, ["funnel", "status", "--json"], { stdio: "pipe", timeout: 15000 }).toString() || "{}");
    }
    catch {
        return {};
    }
}
/** The local target a Funnel HTTPS port forwards "/" to, e.g. "http://127.0.0.1:8797". */
export function funnelTarget(status, host, httpsPort) {
    return status?.Web?.[`${host}:${httpsPort}`]?.Handlers?.["/"]?.Proxy;
}
/** First Funnel port that is unused or already forwards to our local port. */
export function pickFunnelPort(status, host, localPort) {
    const ours = new Set([`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`, `127.0.0.1:${localPort}`]);
    for (const p of FUNNEL_PORTS) {
        const target = funnelTarget(status, host, p);
        const tcpUsed = !!status?.TCP?.[String(p)];
        if (!target && !tcpUsed)
            return p;
        if (target && ours.has(target))
            return p;
    }
    return undefined;
}
export function portFree(port) {
    return new Promise((resolve) => {
        const s = createServer();
        s.once("error", () => resolve(false));
        s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
}
/** True if an AppLock HTTP server answers on this port. */
export async function isAppLock(port) {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        return (await r.text()).startsWith(APP_ID);
    }
    catch {
        return false;
    }
}
/** A local port that is free or already AppLock's — never one another program is using. */
export async function chooseLocalPort(preferred) {
    for (let p = preferred; p < preferred + 50; p++) {
        if ((await portFree(p)) || (await isAppLock(p)))
            return p;
    }
    throw new Error(`No free port found between ${preferred} and ${preferred + 49}. Pass --port.`);
}
export async function waitFor(check, ms, every = 1000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check())
            return true;
        await new Promise((r) => setTimeout(r, every));
    }
    return false;
}
/**
 * Runs `tailscale funnel --bg --https=<p> <local>`, echoing its output. If Funnel
 * isn't enabled yet, Tailscale prints an approval link and waits; we open it.
 */
export function startFunnel(bin, httpsPort, localPort) {
    return new Promise((resolve) => {
        const child = spawn(bin, ["funnel", "--bg", `--https=${httpsPort}`, String(localPort)], { stdio: ["ignore", "pipe", "pipe"] });
        let opened = false;
        const onData = (d) => {
            const s = d.toString();
            process.stderr.write(s);
            const link = s.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
            if (link && !opened && process.platform === "darwin") {
                opened = true;
                process.stderr.write("\nOpening that page so you can turn on Funnel for your Tailscale account…\n");
                spawn("open", [link], { stdio: "ignore", detached: true }).unref();
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const timer = setTimeout(() => child.kill(), 10 * 60_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve(code === 0);
        });
    });
}
export function stopFunnel(bin, httpsPort) {
    try {
        execFileSync(bin, ["funnel", `--https=${httpsPort}`, "off"], { stdio: "ignore", timeout: 15000 });
    }
    catch { }
}
export function copyToClipboard(text) {
    const tools = process.platform === "darwin" ? [["pbcopy", []]] : process.platform === "win32" ? [["clip", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
    for (const [cmd, args] of tools) {
        try {
            execFileSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
            return true;
        }
        catch { }
    }
    return false;
}
