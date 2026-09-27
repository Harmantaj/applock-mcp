import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testExtension } from "./test-extension";
import { CHATGPT_CHATS, mockSites } from "./mock-sites";

// Users of 0.1.0 have everything in chrome.storage.local. Upgrading must keep
// their locked chats locked and their password working.
test("0.1.0 data is migrated to the sync layout without unlocking anything", async () => {
  const { dir: EXT, port: BRIDGE_PORT } = testExtension();
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "applock-mig-")), {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP chatgpt.com 0.0.0.0"],
  });
  try {
    await mockSites(ctx);
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const extId = new URL(sw.url()).host;
    const [secret] = CHATGPT_CHATS;

    // Write a password the 0.1.0 way (same PBKDF2 scheme) plus a lock.
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/popup.html`);
    await page.evaluate(async ({ id, title }) => {
      const enc = new TextEncoder();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await crypto.subtle.importKey("raw", enc.encode("old password"), "PBKDF2", false, ["deriveBits"]);
      const hash = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 }, key, 256);
      const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        auth: { salt: b64(salt), hash: b64(hash), iterations: 600000, credential: { id: "abc", publicKey: "def", alg: -7 } },
        locked: { [`chatgpt:${id}`]: { site: "chatgpt", id, title, lockedAt: 1 } },
      });
    }, secret);

    // A fresh extension page runs the migration on first use.
    await page.reload();
    const after = await page.evaluate(async () => {
      await (globalThis as any).AppLockStore.ready();
      return { sync: await chrome.storage.sync.get(null), local: await chrome.storage.local.get(null) };
    });
    expect(after.sync[`lk:chatgpt:${secret.id}`]).toMatchObject({ site: "chatgpt", id: secret.id });
    expect(after.sync.auth.hash).toBeTruthy();
    expect(after.sync.auth.credential).toBeUndefined();
    expect(after.local.credential).toEqual({ id: "abc", publicKey: "def", alg: -7 });
    expect(after.local.titles[`chatgpt:${secret.id}`]).toBe(secret.title);
    expect(after.local.locked).toBeUndefined();
    expect(after.local.auth).toBeUndefined();

    const ok = await page.evaluate(async () => (await import("./auth.js")).verifyPassword("old password"));
    expect(ok).toBe(true);

    // And the chat is still hidden on the page.
    const chat = await ctx.newPage();
    for (let i = 0; i < 4 && !(await chat.locator("#sidebar").count()); i++) await chat.goto("https://chatgpt.com/").catch(() => {});
    await expect(chat.locator("nav a", { hasText: secret.title })).toBeHidden();
    await expect(chat.locator("nav a", { hasText: CHATGPT_CHATS[1].title })).toBeVisible();
  } finally {
    await ctx.close();
  }
});
