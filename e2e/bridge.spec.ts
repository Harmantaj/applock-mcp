import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CHATGPT_CHATS, mockSites } from "./mock-sites";

// End-to-end: an MCP client (standing in for Claude Code / ChatGPT / Antigravity)
// asks the AppLock server to lock the chat open in the browser, and the real
// extension hides it. Uses the extension's fixed bridge port 47521.
const EXT = resolve(process.cwd(), "extension");
const CLI = resolve(process.cwd(), "dist/cli.js");

let ctx: BrowserContext;
let sw: Worker;
let client: Client;
let root: string;

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
  [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  // Give the extension a password, as the user would in onboarding.
  const extId = new URL(sw.url()).host;
  const setup = await ctx.newPage();
  await setup.goto(`chrome-extension://${extId}/options.html`);
  await setup.getByLabel("New password").fill("pw1234");
  await setup.getByLabel("Repeat password").fill("pw1234");
  await setup.getByRole("button", { name: "Save password" }).click();
  await expect(setup.locator("#pwOk")).toHaveText("Saved.");
  await setup.close();
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
  const locked = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get("locked")).locked).length);
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
  const locked = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get("locked")).locked).length);
  expect(locked).toBe(2);
});
