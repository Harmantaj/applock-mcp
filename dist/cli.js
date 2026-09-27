#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resetBridge, startBridge } from "./bridge.js";
import { applockHome, BRIDGE_PORT } from "./paths.js";
import { createServer, sweepPending, VERSION } from "./server.js";
import { findSession, listSessions } from "./sources.js";
import { deleteKey, retrieveKey, storeKey, touchIdAvailable, touchIdSupported } from "./touchid.js";
import { changePassphrase, createVault, findHidden, hiddenCount, hideSession, listHidden, loadConfig, loadPending, privateKeyFromPassphrase, restoreHidden, saveConfig, } from "./vault.js";
// Until it's on npm, the package installs straight from GitHub.
const PACKAGE_SPEC = process.env.APPLOCK_PACKAGE ?? "https://github.com/Harmantaj/applock-mcp/releases/download/v0.2.0/applock-mcp-0.2.0.tgz";
const argv = process.argv.slice(2);
const INFO_FLAGS = ["--version", "-v", "--help", "-h"];
const cmd = argv[0] && (!argv[0].startsWith("-") || INFO_FLAGS.includes(argv[0])) ? argv[0] : "serve";
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};
function ask(question, hidden = false) {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
        const w = rl._writeToOutput?.bind(rl);
        rl._writeToOutput = (s) => (s.includes(question) ? w?.(s) : w?.(s.replace(/[^\r\n]/g, "")));
    }
    return new Promise((res) => rl.question(question, (a) => {
        rl.close();
        if (hidden)
            process.stderr.write("\n");
        res(a);
    }));
}
async function readStdin() {
    let s = "";
    for await (const c of process.stdin)
        s += c;
    return s.replace(/\r?\n$/, "");
}
async function getPassphrase(prompt = "Passphrase: ") {
    if (flag("passphrase-stdin"))
        return readStdin();
    if (!process.stdin.isTTY)
        throw new Error("No terminal available; pass --passphrase-stdin");
    return ask(prompt, true);
}
/** CLI unlock: Touch ID if enabled, otherwise the passphrase prompt. */
async function cliKey() {
    const cfg = need();
    if (cfg.touchId && touchIdSupported() && !flag("passphrase-stdin")) {
        try {
            return await retrieveKey("open your hidden chats");
        }
        catch (e) {
            console.error(`Touch ID: ${e.message}. Falling back to passphrase.`);
        }
    }
    return privateKeyFromPassphrase(cfg, await getPassphrase());
}
function need() {
    const cfg = loadConfig();
    if (!cfg) {
        console.error("AppLock isn't set up yet. Run:  applock-mcp setup");
        process.exit(1);
    }
    return cfg;
}
/** Absolute path from PATH (stable across upgrades, unlike the resolved Cellar path). */
function onPath(bin) {
    try {
        return execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "pipe" }).toString().trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function selfCommand() {
    // Registered clients launch the same entry point that ran this command.
    const entry = fileURLToPath(import.meta.url);
    const global = onPath("applock-mcp");
    if (entry.includes("/lib/node_modules/applock-mcp/") && global)
        return { command: global, args: [] };
    if (entry.includes("/_npx/") || flag("npx"))
        return { command: onPath("npx") ?? "npx", args: ["-y", PACKAGE_SPEC] };
    return { command: onPath("node") ?? process.execPath, args: [entry] };
}
async function serveStdio() {
    sweepPending();
    await startBridge();
    const server = createServer();
    await server.connect(new StdioServerTransport());
    const bye = () => {
        // The client is closing, but it keeps writing its session file for a moment
        // after stopping us. Hand queued hides to a detached process that waits for
        // the file to go quiet, so the whole session is encrypted in one piece.
        if (loadPending().some((p) => p.id === process.env.CLAUDE_CODE_SESSION_ID)) {
            spawn(process.execPath, [fileURLToPath(import.meta.url), "finish-pending"], {
                detached: true,
                stdio: "ignore",
                env: { ...process.env, CLAUDE_CODE_SESSION_ID: "" },
            }).unref();
        }
        process.exit(0);
    };
    process.stdin.on("end", bye);
    process.stdin.on("close", bye);
    process.on("SIGTERM", bye);
    process.on("SIGINT", bye);
}
function httpSecret() {
    const p = join(applockHome(), "http-secret");
    if (existsSync(p))
        return readFileSync(p, "utf8").trim();
    const s = randomBytes(18).toString("base64url");
    mkdirSync(applockHome(), { recursive: true, mode: 0o700 });
    writeFileSync(p, s, { mode: 0o600 });
    return s;
}
async function serveHttp() {
    const port = Number(opt("port") ?? 8787);
    const host = opt("host") ?? "127.0.0.1";
    const secret = httpSecret();
    sweepPending();
    await startBridge();
    const http = createHttpServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname === "/health")
            return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        // ChatGPT connectors support "no auth", so the unguessable path is the credential.
        if (url.pathname !== `/mcp/${secret}`)
            return void res.writeHead(404).end();
        let body;
        if (req.method === "POST") {
            let raw = "";
            for await (const c of req)
                raw += c;
            try {
                body = JSON.parse(raw);
            }
            catch {
                return void res.writeHead(400).end();
            }
        }
        // Stateless: a fresh server + transport per request.
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
            transport.close();
            server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    });
    http.listen(port, host, () => {
        console.error(`AppLock MCP (Streamable HTTP) listening on http://${host}:${port}/mcp/${secret}`);
        console.error(`Expose it to ChatGPT with:  cloudflared tunnel --url http://localhost:${port}`);
        console.error(`then use  https://<your-tunnel>.trycloudflare.com/mcp/${secret}  as the connector URL.`);
    });
}
/** Waits until every pending session's files stop changing, then hides them. */
async function finishPending() {
    const quietMs = Number(process.env.APPLOCK_QUIET_MS ?? 3000);
    const deadline = Date.now() + 60_000;
    await new Promise((r) => setTimeout(r, Math.min(quietMs, 1500)));
    while (Date.now() < deadline) {
        const newest = Math.max(0, ...loadPending().flatMap((p) => findSession(p.id)?.paths ?? []).map((f) => {
            try {
                return statSync(f).mtimeMs;
            }
            catch {
                return 0;
            }
        }));
        if (Date.now() - newest >= quietMs)
            break;
        await new Promise((r) => setTimeout(r, 500));
    }
    sweepPending({ includeCurrent: true });
}
async function setup() {
    if (loadConfig()) {
        console.error(`A vault already exists at ${applockHome()}. Use "applock-mcp passwd" to change the passphrase.`);
        process.exit(1);
    }
    console.error("AppLock setup — choose a passphrase. It unlocks your hidden chats and cannot be recovered.");
    const pass = await getPassphrase("New passphrase (6+ chars): ");
    if (!flag("passphrase-stdin")) {
        const again = await ask("Repeat passphrase: ", true);
        if (again !== pass)
            throw new Error("Passphrases don't match");
    }
    const minutes = Number(opt("auto-lock") ?? 10);
    let touch = false;
    if (touchIdSupported() && !flag("no-touch-id")) {
        const avail = touchIdAvailable();
        if (avail) {
            touch = flag("touch-id") || (process.stdin.isTTY && !flag("passphrase-stdin") ? /^y/i.test(await ask("Enable Touch ID unlock? [Y/n] ") || "y") : false);
        }
        else
            console.error("Touch ID isn't available on this Mac; using the passphrase only.");
    }
    const { cfg, privateKey } = createVault(pass, { touchId: touch, autoLockMinutes: minutes });
    if (touch) {
        storeKey(privateKey);
        saveConfig({ ...cfg, touchId: true });
    }
    console.error(`\n✓ Vault created at ${applockHome()} (Touch ID: ${touch ? "on" : "off"}, auto-lock ${minutes} min).`);
    console.error("Next: applock-mcp install claude   |   applock-mcp install antigravity   |   applock-mcp install chatgpt");
}
function installClient(client) {
    const self = selfCommand();
    if (client === "claude" || client === "claude-code") {
        const args = ["mcp", "add", "--scope", "user", "applock", "--", self.command, ...self.args];
        try {
            execFileSync("claude", args, { stdio: "inherit" });
        }
        catch {
            console.error(`Couldn't run the claude CLI. Run this yourself:\n  claude ${args.join(" ")}`);
            process.exit(1);
        }
        return;
    }
    if (client === "antigravity") {
        const p = opt("config") ?? join(homedir(), ".gemini", "config", "mcp_config.json");
        let cfg = { mcpServers: {} };
        if (existsSync(p))
            cfg = JSON.parse(readFileSync(p, "utf8") || "{}");
        cfg.mcpServers ??= {};
        cfg.mcpServers.applock = { command: self.command, args: self.args };
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(cfg, null, 2));
        console.error(`✓ Added "applock" to ${p}. Reload MCP servers in Antigravity (Agent panel ▸ … ▸ Manage MCPs ▸ Refresh).`);
        return;
    }
    if (client === "chatgpt") {
        console.error(`ChatGPT only talks to remote MCP servers. Run these two in separate terminals:

  applock-mcp serve --http --port 8787
  cloudflared tunnel --url http://localhost:8787

Then in ChatGPT: Settings ▸ Apps & Connectors ▸ Advanced ▸ enable Developer mode,
Create ▸ paste https://<tunnel>.trycloudflare.com/mcp/${httpSecret()} ▸ Authentication: No authentication.`);
        return;
    }
    console.error("Usage: applock-mcp install <claude|antigravity|chatgpt>");
    process.exit(1);
}
const HELP = `applock-mcp ${VERSION} — lock and hide AI chats

  setup                 create the encrypted vault (passphrase + optional Touch ID)
  install <client>      register with claude | antigravity | chatgpt
  serve                 run the MCP server on stdio (what clients launch)
  serve --http          run over Streamable HTTP for ChatGPT (--port 8787)
  status                show vault state
  list                  list visible Claude Code / Antigravity sessions
  hide <id>             hide a session
  hidden                list hidden items (asks for Touch ID / passphrase)
  restore <id>          restore a hidden session
  passwd                change the passphrase
  touchid on|off        enable or disable Touch ID unlock
  bridge-reset          un-pair the browser extension

Vault: ${applockHome()}   Bridge: 127.0.0.1:${BRIDGE_PORT}`;
async function main() {
    switch (cmd) {
        case "serve":
            return flag("http") ? serveHttp() : serveStdio();
        case "setup":
            return setup();
        case "finish-pending":
            return finishPending();
        case "install":
            return installClient(argv[1]);
        case "status": {
            const cfg = loadConfig();
            console.log(cfg ? `Vault ${applockHome()}\nHidden items: ${hiddenCount()}\nTouch ID: ${cfg.touchId ? "on" : "off"}\nAuto-lock: ${cfg.autoLockMinutes} min` : "Not set up.");
            return;
        }
        case "list":
            for (const s of listSessions("all"))
                console.log(`${s.id}  ${s.source.padEnd(11)}  ${s.updatedAt.slice(0, 10)}  ${s.title}`);
            return;
        case "hide": {
            const cfg = need();
            const s = listSessions("all").find((x) => x.id === argv[1] || (argv[1]?.length >= 6 && x.id.startsWith(argv[1])));
            if (!s)
                throw new Error(`No visible session matches ${argv[1]}`);
            if (s.id === process.env.CLAUDE_CODE_SESSION_ID)
                throw new Error("That session is running; hide it from inside Claude Code instead.");
            const m = hideSession(cfg, s);
            console.log(`Hidden "${m.title}" → vault id ${m.vaultId}`);
            return;
        }
        case "hidden": {
            need();
            const k = await cliKey();
            for (const m of listHidden(k))
                console.log(`${m.vaultId}  ${m.source.padEnd(11)}  ${m.hiddenAt.slice(0, 10)}  ${m.title}`);
            return;
        }
        case "restore": {
            need();
            const k = await cliKey();
            const m = findHidden(k, argv[1] ?? "");
            if (m.source === "browser")
                throw new Error("Web chats are unlocked from the browser extension.");
            restoreHidden(k, m);
            console.log(`Restored "${m.title}"`);
            return;
        }
        case "passwd": {
            const cfg = need();
            const k = privateKeyFromPassphrase(cfg, await getPassphrase("Current passphrase: "));
            const next = await ask("New passphrase: ", true);
            if ((await ask("Repeat: ", true)) !== next)
                throw new Error("Passphrases don't match");
            changePassphrase(cfg, k, next);
            console.log("Passphrase changed.");
            return;
        }
        case "touchid": {
            const cfg = need();
            if (argv[1] === "off") {
                deleteKey();
                saveConfig({ ...cfg, touchId: false });
                console.log("Touch ID disabled.");
            }
            else {
                if (!touchIdAvailable())
                    throw new Error("Touch ID isn't available on this device.");
                storeKey(privateKeyFromPassphrase(cfg, await getPassphrase()));
                saveConfig({ ...cfg, touchId: true });
                console.log("Touch ID enabled.");
            }
            return;
        }
        case "bridge-reset":
            resetBridge();
            console.log("Browser extension un-paired. The next extension to connect will be paired.");
            return;
        case "help":
        case "--help":
        case "-h":
            console.log(HELP);
            return;
        case "--version":
        case "-v":
            console.log(VERSION);
            return;
        default:
            console.error(HELP);
            process.exit(1);
    }
}
main().catch((e) => {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
});
