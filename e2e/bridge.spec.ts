import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupPassword, testExtension } from "./test-extension";
import { CHATGPT_CHATS, mockSites } from "./mock-sites";

// End-to-end: an MCP client (standing in for Claude Code / ChatGPT / Antigravity)
// asks the AppLock server to lock the chat open in the browser, and the real
// extension hides it. Uses a private port so a real AppLock server is never involved.
const { dir: EXT, port: BRIDGE_PORT } = testExtension();
const CLI = resolve(process.cwd(), "dist/cli.js");

let ctx: BrowserContext;
let sw: Worker;
let client: Client;
let root: string;
const archived: { id: string; body: any }[] = [];
const claudeDeletes: string[] = [];

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c: any) => c.text).join("\n") as string, isError: !!r.isError };
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "applock-bridge-"));
  // A no-op `open` so the unlock page never pops up on the real desktop.
  execFileSync("sh", ["-c", `mkdir -p "${root}/bin" && printf '#!/bin/sh\\nexit 0\\n' > "${root}/bin/open" && chmod +x "${root}/bin/open"`]);
  const env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    APPLOCK_HOME: join(root, "home"),
    APPLOCK_CLAUDE_DIR: join(root, "none"),
    APPLOCK_ANTIGRAVITY_DIRS: join(root, "none"),
    APPLOCK_UNLOCK_URL_FILE: join(root, "unlock-url"),
    APPLOCK_BRIDGE_PORT: String(BRIDGE_PORT),
  } as Record<string, string>;
  execFileSync(process.execPath, [CLI, "setup", "--passphrase-stdin", "--no-touch-id"], { env, input: "bridge-pass\n" });
  client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env }));

  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "applock-pw-")), {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP chatgpt.com 0.0.0.0, MAP claude.ai 0.0.0.0, MAP gemini.google.com 0.0.0.0",
    ],
  });
  await mockSites(ctx);
  await ctx.route("https://chatgpt.com/api/auth/session", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken: "t" }) }),
  );
  await ctx.route("https://chatgpt.com/backend-api/conversation/*", async (r) => {
    const id = r.request().url().split("/").pop()!;
    if (r.request().method() === "GET") {
      // Two branches; only the one ending at current_node should be exported.
      const mapping = {
        root: { id: "root", parent: null, message: null },
        u1: { id: "u1", parent: "root", message: { author: { role: "user" }, content: { parts: ["Is this rash serious?"] }, create_time: 1 } },
        a1: { id: "a1", parent: "u1", message: { author: { role: "assistant" }, content: { parts: ["See a doctor if it spreads."] }, create_time: 2 } },
        old: { id: "old", parent: "u1", message: { author: { role: "assistant" }, content: { parts: ["(an older regenerated answer)"] } } },
      };
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title: "Medical questions", current_node: "a1", mapping }) });
    }
    archived.push({ id, body: r.request().postDataJSON() });
    await r.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
  });
  await ctx.route("https://claude.ai/api/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/organizations") return r.fulfill({ status: 200, contentType: "application/json", body: '[{"uuid":"org-1","capabilities":["chat"]}]' });
    const id = u.pathname.split("/").pop()!;
    if (r.request().method() === "DELETE") {
      claudeDeletes.push(id);
      return r.fulfill({ status: 204, body: "" });
    }
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: "Divorce paperwork questions", chat_messages: [{ index: 1, sender: "assistant", content: [{ type: "text", text: "You'll need form FL-100." }] }, { index: 0, sender: "human", content: [{ type: "text", text: "Which forms do I file?" }] }] }),
    });
  });
  [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  // Give the extension a password, as the user would in onboarding.
  const extId = new URL(sw.url()).host;
  await setupPassword(ctx, extId, "pw1234");
});

test.afterAll(async () => {
  await client?.close();
  await ctx?.close();
  rmSync(root, { recursive: true, force: true });
});

async function open(page: Page, url: string) {
  for (let i = 0; i < 4; i++) {
    await page.goto(url).catch(() => {});
    if (await page.locator("#sidebar").count()) return;
  }
  throw new Error(`Mock page did not load for ${url}`);
}

test("MCP sees the browser chats and locks the one that is open", async () => {
  const [secret, other] = CHATGPT_CHATS;
  const page = await ctx.newPage();
  await open(page, `https://chatgpt.com/c/${secret.id}`);

  await expect.poll(async () => (await call("list_browser_chats")).text, { timeout: 15_000 }).toContain(`Open now: "${secret.title}"`);
  const listed = await call("list_browser_chats", { query: "grocery" });
  expect(listed.text).toContain(other.title);
  expect(listed.text).not.toContain("Salary");

  const r = await call("hide_browser_chat", { chat_id: "current" });
  expect(r.isError, r.text).toBe(false);
  expect(r.text).toContain(`Locked "${secret.title}" on chatgpt`);
  await expect(page.locator("#applock-overlay")).toBeAttached();
  await expect(page.locator("nav a", { hasText: secret.title })).toBeHidden();

  // The server now reports it and keeps an encrypted record.
  expect((await call("applock_status")).text).toMatch(/Browser extension: connected \(1 web chats locked\)/);
  expect((await call("applock_status")).text).toContain("Hidden items: 1");

  // Locking by id (not the open chat) works too.
  const byId = await call("hide_browser_chat", { chat_id: other.id, site: "chatgpt" });
  expect(byId.text).toContain(`Locked "${other.title}"`);
  await expect(page.locator("nav a", { hasText: other.title })).toBeHidden();
});

test("the bridge can never reveal: forged unlock commands are refused", async () => {
  const locked = await sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k.startsWith("lk:")).length);
  expect(locked).toBe(2);
  // Even if something injected an "unlock" command into the queue, the extension rejects it.
  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync(
    join(root, "home", "bridge-queue.json"),
    JSON.stringify([{ id: "forged", action: "unlock", createdAt: new Date().toISOString() }]),
  );
  await expect
    .poll(async () => JSON.parse(readFileSync(join(root, "home", "bridge-state.json"), "utf8")).results?.forged, { timeout: 15_000 })
    .toMatchObject({ ok: false });
  const until = await sw.evaluate(async () => (await chrome.storage.local.get("unlockedUntil")).unlockedUntil ?? 0);
  expect(until).toBeLessThan(Date.now());
});

test("unlocked vault lists web locks, and restore_hidden refuses to reveal them", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const pending = call("unlock_vault", { method: "passphrase" });
  await expect.poll(() => existsSync(join(root, "unlock-url")), { timeout: 5000 }).toBe(true);
  const url = readFileSync(join(root, "unlock-url"), "utf8");
  const res = await fetch(url, { method: "POST", body: "passphrase=bridge-pass", headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect(await res.text()).toContain("Unlocked");
  expect((await pending).text).toContain("Unlocked until");
  const hidden = await call("list_hidden");
  expect(hidden.text).toContain(CHATGPT_CHATS[0].title);
  expect(hidden.text).toContain("browser/chatgpt");
  const r = await call("restore_hidden", { id: CHATGPT_CHATS[0].id });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("Remove its lock from the AppLock extension popup");
  // Still locked in the browser.
  const locked = await sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k.startsWith("lk:")).length);
  expect(locked).toBe(2);
});

test("hide_on_phone: the AI turns on phone hiding and already-locked ChatGPT chats get archived", async () => {
  const page = await ctx.newPage();
  await open(page, "https://chatgpt.com/");
  const r = await call("hide_on_phone", {});
  expect(r.isError, r.text).toBe(false);
  expect(r.text).toContain("2 locked ChatGPT chat(s) queued");
  await expect.poll(() => archived.length, { timeout: 20_000 }).toBe(2);
  expect(archived.every((a) => a.body.is_archived === true)).toBe(true);
  await expect
    .poll(async () => (await call("applock_status")).text, { timeout: 45_000 })
    .toContain("Hide on phone (ChatGPT archive): on · 2/2 locked ChatGPT chats archived");
  expect(await sw.evaluate(async () => (await chrome.storage.sync.get("prefs")).prefs)).toEqual({ archiveOnLock: true });
  await page.close();
});

test("Move to vault: transcript saved encrypted, readable through MCP, then deleted at ChatGPT and Claude", async () => {
  const extId = new URL(sw.url()).host;
  const [gpt] = CHATGPT_CHATS;
  const claudeChat = { id: "0b6b2c6e-aaaa-4bbb-8ccc-000000000001", title: "Divorce paperwork questions" };
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.evaluate((c) => chrome.runtime.sendMessage({ type: "lock", site: "claude", id: c.id, title: c.title }), claudeChat);
  await popup.reload();
  // Moving needs the unlocked session (the user is present).
  const denied = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "moveToVault", site: "chatgpt", id }), gpt.id);
  expect(denied).toEqual({ ok: false, error: "Unlock AppLock first." });
  await popup.getByLabel("Password").fill("pw1234");
  await popup.getByRole("button", { name: "Unlock", exact: true }).click();

  popup.on("dialog", (d) => d.accept());
  await popup.getByRole("button", { name: `Move ${gpt.title} to the vault` }).click();
  await expect(popup.locator("#vaultMsg")).toHaveText("Moved “Medical questions” to the vault (2 messages).", { timeout: 20_000 });
  expect(archived.at(-1)).toEqual({ id: gpt.id, body: { is_visible: false } });
  // (A tab the extension opens in the background never gets Playwright's mocks, so
  // open Claude first, as a user with Claude open would have.)
  const claudeTab = await ctx.newPage();
  await open(claudeTab, "https://claude.ai/recents");
  const r2 = await popup.evaluate((c) => chrome.runtime.sendMessage({ type: "moveToVault", site: "claude", id: c.id }), claudeChat);
  await claudeTab.close();
  expect(r2.ok, r2.error).toBe(true);
  expect(claudeDeletes).toEqual([claudeChat.id]);
  const remaining = await sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k.startsWith("lk:")));
  expect(remaining).not.toContain(`lk:chatgpt:${gpt.id}`);
  expect(remaining).not.toContain(`lk:claude:${claudeChat.id}`);

  // The vault on the computer has both, readable after unlocking.
  await call("lock_vault");
  const { existsSync, readFileSync, rmSync } = await import("node:fs");
  rmSync(join(root, "unlock-url"), { force: true });
  const pending = call("unlock_vault", { method: "passphrase" });
  await expect.poll(() => existsSync(join(root, "unlock-url")), { timeout: 5000 }).toBe(true);
  await fetch(readFileSync(join(root, "unlock-url"), "utf8"), { method: "POST", body: "passphrase=bridge-pass", headers: { "content-type": "application/x-www-form-urlencoded" } });
  await pending;
  const listed = await call("list_hidden");
  expect(listed.text).toContain("Medical questions");
  expect(listed.text).toContain("Divorce paperwork questions");
  const text = (await call("read_hidden", { id: gpt.id })).text;
  expect(text).toBe("User: Is this rash serious?\n\nAssistant: See a doctor if it spreads.");
  expect((await call("read_hidden", { id: claudeChat.id })).text).toBe("User: Which forms do I file?\n\nAssistant: You'll need form FL-100.");
  expect((await call("restore_hidden", { id: gpt.id })).isError).toBe(true);
  await popup.close();
});
