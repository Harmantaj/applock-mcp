import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fx = fixture();
const env = { ...process.env, ...fx.env, APPLOCK_QUIET_MS: "1000", APPLOCK_UNLOCK_URL_FILE: join(fx.root, "unlock-url"), CLAUDE_CODE_SESSION_ID: "sess-cccc-3333" };
// Never pop a real browser during tests.
env.PATH = `${join(fx.root, "bin")}:${env.PATH}`;
execFileSync("sh", ["-c", `mkdir -p "${fx.root}/bin" && printf '#!/bin/sh\\nexit 0\\n' > "${fx.root}/bin/open" && chmod +x "${fx.root}/bin/open"`]);

let client;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
};

before(async () => {
  execFileSync(process.execPath, [CLI, "setup", "--passphrase-stdin", "--no-touch-id"], { env, input: "hunter22\n" });
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env }));
});
after(async () => {
  await client?.close();
  rmSync(fx.root, { recursive: true, force: true });
});

test("exposes the expected tools with read-only hints", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "applock_status", "copy_to_vault", "hide_browser_chat", "hide_on_phone", "hide_session", "list_browser_chats", "list_hidden",
    "list_sessions", "lock_vault", "read_hidden", "restore_hidden", "unlock_vault",
  ]);
  const ro = Object.fromEntries(tools.map((t) => [t.name, !!t.annotations?.readOnlyHint]));
  assert.equal(ro.list_sessions, true);
  assert.equal(ro.hide_session, false);
});

test("lists sessions and flags the current one", async () => {
  const r = await call("list_sessions", {});
  assert.match(r.text, /Surprise party plan/);
  assert.match(r.text, /What is 2\+2\?  \(this session\)/);
  const q = await call("list_sessions", { query: "billing" });
  assert.match(q.text, /1 session/);
});

test("hides while locked, and locked vault refuses to list", async () => {
  const h = await call("hide_session", { id: "sess-aaaa" });
  assert.equal(h.isError, false, h.text);
  assert.ok(!existsSync(join(fx.proj, "sess-aaaa-1111.jsonl")));
  const l = await call("list_hidden");
  assert.equal(l.isError, true);
  assert.match(l.text, /locked/);
  const s = await call("applock_status");
  assert.match(s.text, /Hidden items: 1/);
});

test("current session is deferred, not moved", async () => {
  const r = await call("hide_session", { id: "current" });
  assert.match(r.text, /will be encrypted and hidden as soon as it ends/);
  assert.ok(existsSync(join(fx.proj, "sess-cccc-3333.jsonl")));
});

test("unlock happens on a local page, then list/read/restore work", async () => {
  const pending = call("unlock_vault", { method: "passphrase" });
  let url;
  for (let i = 0; i < 50 && !url; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(env.APPLOCK_UNLOCK_URL_FILE)) url = readFileSync(env.APPLOCK_UNLOCK_URL_FILE, "utf8");
  }
  assert.ok(url?.startsWith("http://127.0.0.1:"), "unlock page URL");
  assert.equal((await fetch(url.replace(/\/[^/]+$/, "/wrong"))).status, 404, "token is required");
  const bad = await fetch(url, { method: "POST", body: "passphrase=nope", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.match(await bad.text(), /Wrong passphrase/);
  const good = await fetch(url, { method: "POST", body: "passphrase=hunter22", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.match(await good.text(), /Unlocked/);
  const u = await pending;
  assert.match(u.text, /Unlocked until/);

  const l = await call("list_hidden");
  assert.match(l.text, /Surprise party plan/);
  const rd = await call("read_hidden", { id: "sess-aaaa-1111" });
  assert.match(rd.text, /Assistant: Sure! Who is it for\?/);
  const rs = await call("restore_hidden", { id: "sess-aaaa-1111" });
  assert.match(rs.text, /Restored/);
  assert.ok(existsSync(join(fx.proj, "sess-aaaa-1111.jsonl")));
  assert.match((await call("lock_vault")).text, /Locked/);
  assert.equal((await call("list_hidden")).isError, true);
});

test("the deferred session is hidden when the client disconnects", async () => {
  await client.close();
  client = undefined;
  // The client keeps writing briefly after stopping the server (as Claude Code does).
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(fx.proj, "sess-cccc-3333.jsonl"), JSON.stringify({ type: "last-prompt", lastPrompt: "What is 2+2?" }) + "\n");
  for (let i = 0; i < 80 && existsSync(join(fx.proj, "sess-cccc-3333.jsonl")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!existsSync(join(fx.proj, "sess-cccc-3333.jsonl")), "hidden in one piece after the file went quiet");
  const env2 = { ...env, CLAUDE_CODE_SESSION_ID: "another" };
  client = new Client({ name: "test2", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env: env2 }));
  assert.match((await call("applock_status")).text, /Hidden items: 1/);
});

test("bridge rejects web pages and accepts the extension", async () => {
  const port = env.APPLOCK_BRIDGE_PORT;
  const page = await fetch(`http://127.0.0.1:${port}/bridge/sync`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal(page.status, 403);
  const ext = await fetch(`http://127.0.0.1:${port}/bridge/sync`, {
    method: "POST",
    headers: { origin: "chrome-extension://abcdefghijklmnop", "content-type": "application/json" },
    body: JSON.stringify({ active: { site: "chatgpt", id: "c-1", title: "Therapy notes" }, chats: [{ site: "chatgpt", id: "c-1", title: "Therapy notes" }] }),
  });
  assert.equal(ext.status, 200);
  const other = await fetch(`http://127.0.0.1:${port}/bridge/sync`, { method: "POST", headers: { origin: "chrome-extension://zzzzzzzzzzzzzzzz" }, body: "{}" });
  assert.equal(other.status, 403, "second extension is rejected after pairing");
  const r = await call("list_browser_chats");
  assert.match(r.text, /Open now: "Therapy notes"/);

  // Simulate the extension acking a lock command.
  const lockCall = call("hide_browser_chat", { chat_id: "current" });
  let cmd;
  for (let i = 0; i < 40 && !cmd; i++) {
    await new Promise((res) => setTimeout(res, 100));
    const res = await fetch(`http://127.0.0.1:${port}/bridge/sync`, { method: "POST", headers: { origin: "chrome-extension://abcdefghijklmnop" }, body: "{}" });
    cmd = (await res.json()).commands[0];
  }
  assert.equal(cmd.action, "lock");
  assert.equal(cmd.chatId, "c-1");
  await fetch(`http://127.0.0.1:${port}/bridge/sync`, {
    method: "POST",
    headers: { origin: "chrome-extension://abcdefghijklmnop" },
    body: JSON.stringify({ results: [{ id: cmd.id, ok: true, chat: { site: "chatgpt", id: "c-1", title: "Therapy notes" } }] }),
  });
  assert.match((await lockCall).text, /Locked "Therapy notes" on chatgpt/);
});

test("Streamable HTTP transport (ChatGPT) serves the same tools behind the secret path", async () => {
  const port = String(30000 + Math.floor(Math.random() * 9000));
  const proc = spawn(process.execPath, [CLI, "serve", "--http", "--port", port], { env: { ...env, APPLOCK_BRIDGE_PORT: "1" } });
  let log = "";
  proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !log.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));
  const url = log.match(/(http:\/\/127\.0\.0\.1:\d+\/mcp\/\S+)/)[1];
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp/guess`, { method: "POST" })).status, 404);
    const c = new Client({ name: "chatgpt-sim", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await c.listTools();
    assert.equal(tools.length, 12);
    const st = await c.callTool({ name: "applock_status", arguments: {} });
    assert.match(st.content[0].text, /Vault: locked/);
    await c.close();
  } finally {
    proc.kill();
  }
});

test("remote (phone) unlock: one-time link on the public URL, passphrase never in the tool call", async () => {
  const port = String(30000 + Math.floor(Math.random() * 9000));
  const proc = spawn(process.execPath, [CLI, "serve", "--http", "--port", port, "--public-url", `http://127.0.0.1:${port}`.replace("http:", "https:")], {
    env: { ...env, APPLOCK_BRIDGE_PORT: "1" },
  });
  let log = "";
  proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !log.includes("Connector URL"); i++) await new Promise((r) => setTimeout(r, 100));
  const local = log.match(/(http:\/\/127\.0\.0\.1:\d+\/mcp\/\S+)/)[1];
  assert.match(log, new RegExp(`Connector URL: https://127\\.0\\.0\\.1:${port}/mcp/`));
  try {
    const c = new Client({ name: "claude-phone-sim", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(local)));
    const r = await c.callTool({ name: "unlock_vault", arguments: {} });
    const link = r.content[0].text.match(/https:\/\/\S+\/unlock\/\S+/)[0];
    // The public URL is https (the tunnel); talk to the same server locally.
    const direct = link.replace("https:", "http:");
    assert.equal((await fetch(direct)).status, 200);
    assert.equal((await fetch(direct.replace(/unlock\/.+$/, "unlock/forged"))).status, 404);
    const form = (p) => ({ method: "POST", body: `passphrase=${p}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.match(await (await fetch(direct, form("nope"))).text(), /Wrong passphrase/);
    assert.match(await (await fetch(direct, form("hunter22"))).text(), /Unlocked/);
    assert.equal((await fetch(direct)).status, 404, "link is single-use");
    const st = await c.callTool({ name: "applock_status", arguments: {} });
    assert.match(st.content[0].text, /Vault: unlocked until/);
    const hidden = await c.callTool({ name: "list_hidden", arguments: {} });
    assert.equal(!!hidden.isError, false);
    await c.close();
  } finally {
    proc.kill();
  }
});

test("phone vault web app: secret path, passphrase login, lockout, reading a vaulted chat", async () => {
  // Put a web chat in the vault the way the extension does (bridge, locked vault).
  const bport = env.APPLOCK_BRIDGE_PORT;
  const ext = "chrome-extension://abcdefghijklmnop";
  const saved = await fetch(`http://127.0.0.1:${bport}/bridge/vault`, {
    method: "POST",
    headers: { origin: ext, "content-type": "application/json" },
    body: JSON.stringify({ site: "chatgpt", id: "c-vault-1", title: "Medical questions", messages: [{ role: "user", text: "Is this rash serious?" }, { role: "assistant", text: "See a doctor if it spreads." }] }),
  }).then((r) => r.json());
  assert.match(saved.vaultId, /^[0-9a-f-]{36}$/);
  // Only the paired extension may do that.
  assert.equal((await fetch(`http://127.0.0.1:${bport}/bridge/vault`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);

  const port = String(30000 + Math.floor(Math.random() * 9000));
  const proc = spawn(process.execPath, [CLI, "serve", "--http", "--port", port], { env: { ...env, APPLOCK_BRIDGE_PORT: "1" } });
  try {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok) break;
    }
    const secret = readFileSync(join(fx.home, "vault-secret"), "utf8").trim();
    const base = `http://127.0.0.1:${port}/vault/${secret}`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/vault/wrong/`)).status, 404, "secret path required");
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /autocomplete="current-password"/);
    assert.equal((await fetch(base + "/api/items")).status, 401, "locked by default");
    const login = (p) => fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: p }) });
    assert.equal((await login("nope")).status, 401);
    const ok = await login("hunter22");
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie");
    assert.match(cookie, /al_vault=[A-Za-z0-9_-]+; Path=\/vault\/.+; HttpOnly; Secure; SameSite=Strict/);
    const headers = { cookie: cookie.split(";")[0] };
    assert.equal((await fetch(base + "/api/items")).status, 401, "no cookie, no access");
    const items = (await fetch(base + "/api/items", { headers }).then((r) => r.json())).items;
    const item = items.find((i) => i.title === "Medical questions");
    assert.equal(item.vaulted, true);
    const chat = await fetch(`${base}/api/items/${item.id}`, { headers }).then((r) => r.json());
    assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(chat.messages[0].text, "Is this rash serious?");
    // Locking ends the session.
    await fetch(base + "/api/logout", { method: "POST", headers });
    assert.equal((await fetch(base + "/api/items", { headers })).status, 401);
    // Five wrong passphrases lock the page for a while.
    for (let i = 0; i < 5; i++) await login("wrong");
    assert.equal((await login("hunter22")).status, 429);
  } finally {
    proc.kill();
  }
});
