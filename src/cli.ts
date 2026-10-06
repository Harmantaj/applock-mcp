#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resetBridge, startBridge } from "./bridge.js";
import { applockHome, BRIDGE_PORT } from "./paths.js";
import { handleUnlockLink } from "./unlock.js";
import { handleVaultWeb, vaultSecret } from "./vaultweb.js";
import {
  APP_ID,
  chooseLocalPort,
  copyToClipboard,
  FUNNEL_PORTS,
  funnelStatus,
  funnelTarget,
  isAppLock,
  pickFunnelPort,
  portFree,
  startFunnel,
  stopFunnel,
  tailscaleBin,
  tailscaleStatus,
  waitFor,
} from "./phone.js";
import { createServer, sweepPending, VERSION } from "./server.js";
import { findSession, listSessions } from "./sources.js";
import { deleteKey, retrieveKey, storeKey, touchIdAvailable, touchIdSupported } from "./touchid.js";
import {
  changePassphrase,
  createVault,
  findHidden,
  hiddenCount,
  hideSession,
  listHidden,
  loadConfig,
  loadPending,
  privateKeyFromPassphrase,
  restoreHidden,
  saveConfig,
} from "./vault.js";

// Until it's on npm, the package installs straight from GitHub.
const PACKAGE_SPEC = process.env.APPLOCK_PACKAGE ?? "https://github.com/Harmantaj/applock-mcp/releases/download/v0.6.4/applock-mcp-0.6.4.tgz";
const argv = process.argv.slice(2);
const INFO_FLAGS = ["--version", "-v", "--help", "-h"];
const cmd = argv[0] && (!argv[0].startsWith("-") || INFO_FLAGS.includes(argv[0])) ? argv[0] : "serve";
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) {
    const w = (rl as any)._writeToOutput?.bind(rl);
    (rl as any)._writeToOutput = (s: string) => (s.includes(question) ? w?.(s) : w?.(s.replace(/[^\r\n]/g, "")));
  }
  return new Promise((res) =>
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      res(a);
    }),
  );
}

async function readStdin(): Promise<string> {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s.replace(/\r?\n$/, "");
}

async function getPassphrase(prompt = "Passphrase: "): Promise<string> {
  if (flag("passphrase-stdin")) return readStdin();
  if (!process.stdin.isTTY) throw new Error("No terminal available; pass --passphrase-stdin");
  return ask(prompt, true);
}

/** CLI unlock: Touch ID if enabled, otherwise the passphrase prompt. */
async function cliKey(): Promise<Buffer> {
  const cfg = need();
  if (cfg.touchId && touchIdSupported() && !flag("passphrase-stdin")) {
    try {
      return await retrieveKey("open your hidden chats");
    } catch (e: any) {
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
function onPath(bin: string): string | undefined {
  try {
    return execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "pipe" }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

function selfCommand(): { command: string; args: string[] } {
  // Registered clients launch the same entry point that ran this command.
  const entry = fileURLToPath(import.meta.url);
  const global = onPath("applock-mcp");
  if (entry.includes("/lib/node_modules/applock-mcp/") && global) return { command: global, args: [] };
  if (entry.includes("/_npx/") || flag("npx")) return { command: onPath("npx") ?? "npx", args: ["-y", PACKAGE_SPEC] };
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

function httpSecret(): string {
  const p = join(applockHome(), "http-secret");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const s = randomBytes(18).toString("base64url");
  mkdirSync(applockHome(), { recursive: true, mode: 0o700 });
  writeFileSync(p, s, { mode: 0o600 });
  return s;
}

function publicUrlOpt(): string | undefined {
  const u = opt("public-url") ?? process.env.APPLOCK_PUBLIC_URL;
  if (!u) return undefined;
  if (!/^https:\/\//.test(u)) throw new Error("--public-url must start with https://");
  return u.replace(/\/$/, "");
}

async function serveHttp() {
  const port = Number(opt("port") ?? 8787);
  const host = opt("host") ?? "127.0.0.1";
  const secret = httpSecret();
  const publicUrl = publicUrlOpt();
  sweepPending();
  await startBridge();
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end(`${APP_ID} ok ${VERSION}`);
    if (url.pathname.startsWith("/vault/") && (await handleVaultWeb(loadConfig(), req, res))) return;
    if (url.pathname.startsWith("/unlock/")) {
      const cfg = loadConfig();
      if (cfg && (await handleUnlockLink(cfg, url.pathname.slice(8), req, res))) return;
      return void res.writeHead(404, { "content-type": "text/plain" }).end("This unlock link has expired. Ask for a new one.");
    }
    // Remote connectors support "no auth", so the unguessable path is the credential.
    if (url.pathname !== `/mcp/${secret}`) return void res.writeHead(404).end();
    let body: unknown;
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      try {
        body = JSON.parse(raw);
      } catch {
        return void res.writeHead(400).end();
      }
    }
    // Stateless: a fresh server + transport per request; unlock state is process-wide.
    const server = createServer({ publicUrl });
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
    const vault = vaultSecret();
    if (publicUrl) {
      console.error(`Connector URL: ${publicUrl}/mcp/${secret}`);
      console.error(`Phone vault:   ${publicUrl}/vault/${vault}/`);
    }
    else {
      console.error(`Expose it with a tunnel, e.g.  tailscale funnel --bg ${port}`);
      console.error(`then restart with --public-url https://<your-tunnel-host> so phone unlock links work.`);
    }
  });
}

// ---- remote service (launchd) -------------------------------------------------------

const AGENT_LABEL = "com.applock.mcp.remote";
const agentPath = () => join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);

function xml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Keeps `serve --http` running in the background (macOS launchd), restarting it on login. */
async function installRemote(params: { publicUrl?: string; port?: number; quiet?: boolean } = {}) {
  if (process.platform !== "darwin") throw new Error("install remote uses launchd and is macOS-only. Run `applock-mcp serve --http --public-url …` under your own service manager.");
  const publicUrl = params.publicUrl ?? publicUrlOpt();
  if (!publicUrl) throw new Error("Pass your tunnel address, e.g.  applock-mcp install remote --public-url https://my-mac.tailnet-name.ts.net");
  if (!loadConfig()) throw new Error("Run  applock-mcp setup  first.");
  const port = params.port ?? Number(opt("port") ?? 8797);
  // Never take over a port another program is serving (it would end up on the internet).
  if (!(await portFree(port)) && !(await isAppLock(port)) && !existsSync(agentPath()))
    throw new Error(`Port ${port} is already used by another program. Pick a different --port.`);
  const node = onPath("node") ?? process.execPath;
  const args = [node, fileURLToPath(import.meta.url), "serve", "--http", "--port", String(port), "--public-url", publicUrl];
  const log = join(applockHome(), "remote.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict><key>APPLOCK_HOME</key><string>${xml(applockHome())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(agentPath()), { recursive: true });
  const domain = `gui/${process.getuid?.()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${AGENT_LABEL}`], { stdio: "ignore" });
  } catch {}
  // bootout is asynchronous; wait for the old instance to release the port.
  await waitFor(async () => (await portFree(port)) || !(await isAppLock(port)), 5000, 200);
  writeFileSync(agentPath(), plist);
  // The log prints the connector and vault URLs; Umask 077 covers new files, this covers an existing one.
  if (existsSync(log)) chmodSync(log, 0o600);
  execFileSync("launchctl", ["bootstrap", domain, agentPath()], { stdio: "inherit" });
  if (params.quiet) return;
  console.error(`✓ AppLock now runs in the background on port ${port} (log: ${log}).`);
  console.error(`\nAdd this as a custom connector in Claude (claude.ai › Settings › Connectors › Add custom connector):\n\n  ${publicUrl}/mcp/${httpSecret()}\n`);
  console.error("Treat that URL like a password. `applock-mcp remote rotate` issues a new one.");
}

/** Reads the public URL the background service was installed with. */
function installedPublicUrl(): string | undefined {
  if (!existsSync(agentPath())) return undefined;
  return readFileSync(agentPath(), "utf8").match(/--public-url<\/string><string>([^<]+)</)?.[1];
}

function installedPort(): number | undefined {
  if (!existsSync(agentPath())) return undefined;
  const p = readFileSync(agentPath(), "utf8").match(/--port<\/string><string>(\d+)</)?.[1];
  return p ? Number(p) : undefined;
}

function connectorUrl(publicUrl: string) {
  return `${publicUrl}/mcp/${httpSecret()}`;
}

function showConnector(url: string) {
  const copied = copyToClipboard(url);
  const vault = `${new URL(url).origin}/vault/${vaultSecret()}/`;
  console.error(`
AppLock Vault for your phone (open it in Safari, then Share › Add to Home Screen):

  ${vault}
`);
  console.error(`
Your AppLock connector URL${copied ? " (copied to the clipboard)" : ""}:

  ${url}

Treat it like a password. Add it once and it works everywhere you use Claude:
  1. Open https://claude.ai/new#customize/connectors in a browser (Settings › Connectors).
  2. Add › Add custom connector. Name: AppLock. MCP server URL: paste the URL above.
  3. It now appears in Claude on the web, the Claude desktop app and the Claude
     iPhone/Android apps. Turn it on from the tools menu in a chat.
ChatGPT: only chatgpt.com (Settings › Apps & Connectors › Advanced › Developer mode,
no authentication). ChatGPT's phone apps can't use custom connectors.
Leaked? Run  applock-mcp remote rotate  and re-add it.`);
}

/** One command: Tailscale Funnel + background service + checks + connector URL. */
async function installPhone() {
  if (process.platform !== "darwin")
    throw new Error("install phone automates macOS. Elsewhere, run  applock-mcp serve --http --public-url https://…  behind your own HTTPS tunnel.");
  if (!loadConfig()) {
    if (!process.stdin.isTTY) throw new Error("Run  applock-mcp setup  first.");
    console.error("First, create your AppLock vault.\n");
    await setup();
  }
  const ts = tailscaleBin();
  if (!ts)
    throw new Error(`Tailscale isn't installed. Install it, open it and sign in, then run this again:

  brew install --cask tailscale-app      (or get Tailscale from the Mac App Store)`);
  const st = tailscaleStatus(ts);
  if (!st.running || !st.host) throw new Error("Tailscale isn't signed in. Open Tailscale from the menu bar, log in, then run this again.");
  console.error(`✓ Tailscale is signed in as ${st.host}`);

  const port = opt("port") ? Number(opt("port")) : (installedPort() ?? (await chooseLocalPort(8797)));
  const httpsPort = pickFunnelPort(funnelStatus(ts), st.host, port);
  if (!httpsPort)
    throw new Error(`Tailscale Funnel on this Mac already serves other things on ports ${FUNNEL_PORTS.join(", ")}. AppLock won't replace them.`);
  const publicUrl = `https://${st.host}${httpsPort === 443 ? "" : `:${httpsPort}`}`;

  await installRemote({ publicUrl, port, quiet: true });
  if (!(await waitFor(() => isAppLock(port), 15000))) throw new Error(`AppLock didn't start on port ${port}. See ${join(applockHome(), "remote.log")}.`);
  console.error(`✓ AppLock runs in the background on 127.0.0.1:${port} and starts again when you log in`);

  if (funnelTarget(funnelStatus(ts), st.host, httpsPort) !== `http://127.0.0.1:${port}`) {
    console.error(`Turning on Tailscale Funnel (${publicUrl} → 127.0.0.1:${port})…`);
    if (!(await startFunnel(ts, httpsPort, port))) throw new Error("Tailscale Funnel didn't start. Run the command again after approving Funnel for your account.");
  }
  console.error(`✓ Funnel: ${publicUrl} → 127.0.0.1:${port} (only AppLock is exposed)`);

  const reachable = await waitFor(async () => {
    try {
      const r = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(8000) });
      return (await r.text()).startsWith(APP_ID);
    } catch {
      return false;
    }
  }, 90_000, 3000);
  if (!reachable) console.error("! The public address didn't answer yet (new HTTPS certificates can take a minute). It should work shortly.");
  else console.error("✓ Reachable from the internet");
  showConnector(connectorUrl(publicUrl));
}

async function uninstallPhone() {
  const ts = tailscaleBin();
  const port = installedPort();
  const url = installedPublicUrl();
  if (ts && port && url) {
    const host = new URL(url).hostname;
    const httpsPort = Number(new URL(url).port || 443);
    // Only turn off the Funnel route that points at AppLock.
    if (funnelTarget(funnelStatus(ts), host, httpsPort) === `http://127.0.0.1:${port}`) stopFunnel(ts, httpsPort);
  }
  uninstallRemote();
  console.error("✓ Phone access removed. Delete the AppLock connector in Claude too.");
}

function uninstallRemote() {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid?.()}/${AGENT_LABEL}`], { stdio: "ignore" });
  } catch {}
  rmSync(agentPath(), { force: true });
  console.error("✓ Background AppLock service removed.");
}

function rotateSecret() {
  const p = join(applockHome(), "http-secret");
  rmSync(p, { force: true });
  const s = httpSecret();
  console.error("✓ New connector secret created. The old connector URL no longer works.");
  if (existsSync(agentPath())) {
    execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/${AGENT_LABEL}`], { stdio: "ignore" });
    const url = installedPublicUrl();
    if (url) showConnector(connectorUrl(url));
  } else console.error(`New path: /mcp/${s}`);
}

/** Waits until every pending session's files stop changing, then hides them. */
async function finishPending() {
  const quietMs = Number(process.env.APPLOCK_QUIET_MS ?? 3000);
  const deadline = Date.now() + 60_000;
  await new Promise((r) => setTimeout(r, Math.min(quietMs, 1500)));
  while (Date.now() < deadline) {
    const newest = Math.max(
      0,
      ...loadPending().flatMap((p) => findSession(p.id)?.paths ?? []).map((f) => {
        try {
          return statSync(f).mtimeMs;
        } catch {
          return 0;
        }
      }),
    );
    if (Date.now() - newest >= quietMs) break;
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
    if (again !== pass) throw new Error("Passphrases don't match");
  }
  const minutes = Number(opt("auto-lock") ?? 10);
  let touch = false;
  if (touchIdSupported() && !flag("no-touch-id")) {
    const avail = touchIdAvailable();
    if (avail) {
      touch = flag("touch-id") || (process.stdin.isTTY && !flag("passphrase-stdin") ? /^y/i.test(await ask("Enable Touch ID unlock? [Y/n] ") || "y") : false);
    } else console.error("Touch ID isn't available on this Mac; using the passphrase only.");
  }
  const { cfg, privateKey } = createVault(pass, { touchId: touch, autoLockMinutes: minutes });
  if (touch) {
    storeKey(privateKey);
    saveConfig({ ...cfg, touchId: true });
  }
  console.error(`\n✓ Vault created at ${applockHome()} (Touch ID: ${touch ? "on" : "off"}, auto-lock ${minutes} min).`);
  console.error("Next: applock-mcp install claude   |   applock-mcp install antigravity   |   applock-mcp install phone");
}

function installClient(client: string | undefined) {
  if (client === "remote") return installRemote();
  if (client === "phone" || client === "connector") return installPhone();
  const self = selfCommand();
  if (client === "claude" || client === "claude-code") {
    const args = ["mcp", "add", "--scope", "user", "applock", "--", self.command, ...self.args];
    try {
      execFileSync("claude", args, { stdio: "inherit" });
    } catch {
      console.error(`Couldn't run the claude CLI. Run this yourself:\n  claude ${args.join(" ")}`);
      process.exit(1);
    }
    return;
  }
  if (client === "antigravity") {
    const p = opt("config") ?? join(homedir(), ".gemini", "config", "mcp_config.json");
    let cfg: any = { mcpServers: {} };
    if (existsSync(p)) cfg = JSON.parse(readFileSync(p, "utf8") || "{}");
    cfg.mcpServers ??= {};
    cfg.mcpServers.applock = { command: self.command, args: self.args };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    console.error(`✓ Added "applock" to ${p}. Reload MCP servers in Antigravity (Agent panel ▸ … ▸ Manage MCPs ▸ Refresh).`);
    return;
  }
  if (client === "chatgpt" || client === "chatgpt-web") return installPhone();
  console.error("Usage: applock-mcp install <claude|antigravity|phone>");
  process.exit(1);
}

const HELP = `applock-mcp ${VERSION} — lock and hide AI chats

  setup                 create the encrypted vault (passphrase + optional Touch ID)
  install <client>      register with claude | antigravity | chatgpt
  serve                 run the MCP server on stdio (what clients launch)
  serve --http          run over Streamable HTTP (--port 8787, --public-url https://…)
  install phone         one step: Tailscale Funnel + background service + connector URL
                        for Claude (web, desktop, iPhone, Android) and ChatGPT web
  uninstall phone       turn that off again
  remote url            show and copy the connector URL
  remote rotate         issue a new connector URL (the old one stops working)
  install remote        advanced: background service for your own tunnel (--public-url)
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
      for (const s of listSessions("all")) console.log(`${s.id}  ${s.source.padEnd(11)}  ${s.updatedAt.slice(0, 10)}  ${s.title}`);
      return;
    case "hide": {
      const cfg = need();
      const s = listSessions("all").find((x) => x.id === argv[1] || (argv[1]?.length >= 6 && x.id.startsWith(argv[1])));
      if (!s) throw new Error(`No visible session matches ${argv[1]}`);
      if (s.id === process.env.CLAUDE_CODE_SESSION_ID) throw new Error("That session is running; hide it from inside Claude Code instead.");
      const m = hideSession(cfg, s);
      console.log(`Hidden "${m.title}" → vault id ${m.vaultId}`);
      return;
    }
    case "hidden": {
      need();
      const k = await cliKey();
      for (const m of listHidden(k)) console.log(`${m.vaultId}  ${m.source.padEnd(11)}  ${m.hiddenAt.slice(0, 10)}  ${m.title}`);
      return;
    }
    case "restore": {
      need();
      const k = await cliKey();
      const m = findHidden(k, argv[1] ?? "");
      if (m.source === "browser") throw new Error("Web chats are unlocked from the browser extension.");
      restoreHidden(k, m);
      console.log(`Restored "${m.title}"`);
      return;
    }
    case "passwd": {
      const cfg = need();
      const k = privateKeyFromPassphrase(cfg, await getPassphrase("Current passphrase: "));
      const next = await ask("New passphrase: ", true);
      if ((await ask("Repeat: ", true)) !== next) throw new Error("Passphrases don't match");
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
      } else {
        if (!touchIdAvailable()) throw new Error("Touch ID isn't available on this device.");
        storeKey(privateKeyFromPassphrase(cfg, await getPassphrase()));
        saveConfig({ ...cfg, touchId: true });
        console.log("Touch ID enabled.");
      }
      return;
    }
    case "uninstall":
      if (argv[1] === "remote") return uninstallRemote();
      if (argv[1] === "phone" || argv[1] === "connector") return uninstallPhone();
      throw new Error("Usage: applock-mcp uninstall <phone|remote>");
    case "remote":
      if (argv[1] === "rotate") return rotateSecret();
      if (argv[1] === "url") {
        const u = installedPublicUrl();
        if (!u) throw new Error("Phone access isn't set up. Run  applock-mcp install phone");
        return showConnector(connectorUrl(u));
      }
      throw new Error("Usage: applock-mcp remote <url|rotate>");
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
