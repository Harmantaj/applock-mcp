import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPassword, testExtension } from "./test-extension";
import { CHATGPT_CHATS, mockSites } from "./mock-sites";

// "Hide on your phone too": locking a ChatGPT chat archives it through ChatGPT's
// own API, so it leaves the chat list in the iPhone/Android/desktop apps.
let ctx: BrowserContext;
let sw: Worker;
let extId: string;
const patches: { id: string; body: any; auth: string | undefined }[] = [];
let serverUp = true;

test.beforeAll(async () => {
  const { dir } = testExtension();
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "applock-arch-")), {
    channel: "chromium",
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--host-resolver-rules=MAP chatgpt.com 0.0.0.0"],
  });
  await mockSites(ctx);
  // Registered later, so these win over the catch-all page mock.
  await ctx.route("https://chatgpt.com/api/auth/session", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken: "test-token" }) }),
  );
  await ctx.route("https://chatgpt.com/backend-api/conversation/*", async (r) => {
    if (!serverUp) return r.fulfill({ status: 503, body: "down" });
    patches.push({ id: r.request().url().split("/").pop()!, body: r.request().postDataJSON(), auth: r.request().headers()["authorization"] });
    await r.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
  });
  [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  extId = new URL(sw.url()).host;
  await setupPassword(ctx, extId, "pw1234");
});
test.afterAll(() => ctx?.close());

async function open(page: Page, url: string) {
  for (let i = 0; i < 4; i++) {
    await page.goto(url).catch(() => {});
    if (await page.locator("#sidebar").count()) return;
  }
  throw new Error(`Mock page did not load for ${url}`);
}
const lockRecord = (id: string) => sw.evaluate(async (k) => (await chrome.storage.sync.get(k))[k], `lk:chatgpt:${id}`);
const pendingOps = () => sw.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k.startsWith("op:")));

test("off by default: locking doesn't touch the ChatGPT account, and the popup explains the phone gap", async () => {
  const [chat] = CHATGPT_CHATS;
  const page = await ctx.newPage();
  await open(page, `https://chatgpt.com/c/${chat.id}`);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://chatgpt.com/*" }))[0].id);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.getByRole("button", { name: "Lock this chat" }).click();
  await expect(popup.locator("#phoneTip")).toBeVisible();
  await page.waitForTimeout(2000);
  expect(patches).toEqual([]);
  expect(await pendingOps()).toEqual([]);
  await popup.close();
  await page.close();
});

test("turning it on archives existing locks, and new locks archive straight away", async () => {
  const [first, second] = CHATGPT_CHATS;
  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.getByLabel("When I lock a ChatGPT chat, also archive it in ChatGPT").check();
  await options.getByRole("button", { name: "Archive the ChatGPT chats I already locked" }).click();
  await expect(options.locator("#archiveOk")).toContainText("Queued 1");
  await options.close();

  // No ChatGPT tab is open, so the job waits (it's synced, so any computer can run it).
  expect(await pendingOps()).toEqual([`op:chatgpt:${first.id}`]);

  const page = await ctx.newPage();
  await open(page, "https://chatgpt.com/");
  await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(1);
  expect(patches[0]).toEqual({ id: first.id, body: { is_archived: true }, auth: "Bearer test-token" });
  await expect.poll(() => pendingOps()).toEqual([]);
  expect(await lockRecord(first.id)).toMatchObject({ archived: true });

  // A new lock while ChatGPT is open is archived right away.
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.evaluate(({ id, title }) => chrome.runtime.sendMessage({ type: "lock", site: "chatgpt", id, title }), second);
  await p.close();
  await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(2);
  expect(patches[1]).toMatchObject({ id: second.id, body: { is_archived: true } });
  await page.close();
});

test("a failed request stays queued and is retried", async () => {
  const third = CHATGPT_CHATS[2];
  serverUp = false;
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.evaluate(({ id, title }) => chrome.runtime.sendMessage({ type: "lock", site: "chatgpt", id, title }), third);
  const page = await ctx.newPage();
  await open(page, "https://chatgpt.com/");
  await page.waitForTimeout(2500);
  expect(await pendingOps()).toEqual([`op:chatgpt:${third.id}`]);
  serverUp = true;
  await page.reload();
  await expect.poll(() => pendingOps(), { timeout: 10_000 }).toEqual([]);
  expect(patches.at(-1)).toMatchObject({ id: third.id, body: { is_archived: true } });
  await page.close();
  await p.close();
});

test("removing a lock unarchives the chat so it comes back everywhere", async () => {
  const [first] = CHATGPT_CHATS;
  const page = await ctx.newPage();
  await open(page, "https://chatgpt.com/");
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByLabel("Password").fill("pw1234");
  await popup.getByRole("button", { name: "Unlock", exact: true }).click();
  await popup.getByRole("button", { name: `Remove lock from ${first.title}` }).click();
  await expect.poll(() => patches.at(-1), { timeout: 10_000 }).toMatchObject({ id: first.id, body: { is_archived: false } });
  expect(await lockRecord(first.id)).toBeUndefined();
  await popup.close();
  await page.close();
});

test("phone lock button: shown on touch screens, locks the open chat in one tap", async () => {
  const chat = { id: "67a1f0aa-4444-8000-9000-000000000004", title: "New chat" };
  await sw.evaluate(() => chrome.storage.local.get("settings").then(({ settings = {} }) => chrome.storage.local.set({ settings: { ...settings, lockButton: "always" } })));
  const page = await ctx.newPage();
  await open(page, `https://chatgpt.com/c/${chat.id}`);
  const button = page.locator("#applock-fab");
  await expect(button).toBeAttached();
  // Closed shadow root: click by position, as a finger would.
  const box = (await button.evaluate((el) => {
    const r = (el as any).shadowRoot; // closed: null for the page
    return r;
  })) as null;
  expect(box).toBeNull();
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width - 14 - 22, vp.height - 88 - 22);
  await expect(page.locator("#applock-overlay")).toBeAttached();
  await expect(button).not.toBeAttached();
  expect(await lockRecord(chat.id)).toMatchObject({ site: "chatgpt", id: chat.id });
  await sw.evaluate(() => chrome.storage.local.get("settings").then(({ settings = {} }) => chrome.storage.local.set({ settings: { ...settings, lockButton: "never" } })));
  await page.close();
});

test("Move to vault never deletes anything if the vault on the computer can't save it", async () => {
  // No AppLock server runs in this browser's test, so the vault is unreachable.
  const [chat] = CHATGPT_CHATS;
  await ctx.route("https://chatgpt.com/backend-api/conversation/*", async (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title: "x", current_node: "a", mapping: { a: { parent: null, message: { author: { role: "user" }, content: { parts: ["hi"] } } } } }) });
    patches.push({ id: r.request().url().split("/").pop()!, body: r.request().postDataJSON(), auth: r.request().headers()["authorization"] });
    await r.fulfill({ status: 200, body: "{}" });
  });
  const before = patches.length;
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.evaluate(({ id, title }) => chrome.runtime.sendMessage({ type: "lock", site: "chatgpt", id, title }), chat);
  await p.reload();
  await p.getByLabel("Password").fill("pw1234");
  await p.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(p.locator("#state")).toContainText("Unlocked");
  const page = await ctx.newPage();
  await open(page, "https://chatgpt.com/");
  const r = await p.evaluate((id) => chrome.runtime.sendMessage({ type: "moveToVault", site: "chatgpt", id }), chat.id);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("Nothing was deleted");
  await page.waitForTimeout(1000);
  expect(patches.slice(before).filter((x) => x.body?.is_visible === false)).toEqual([]);
  expect(await lockRecord(chat.id)).toBeTruthy();
  await page.close();
  await p.close();
});
