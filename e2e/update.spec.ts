import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testExtension } from "./test-extension";
import { mockSites } from "./mock-sites";

// Unpacked installs updated in place (unzip over, git pull) keep running the old
// background code until reloaded. Opening a chat site reloads it automatically.
test("an updated unpacked extension reloads itself when a chat site is opened", async () => {
  const { dir } = testExtension();
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "applock-upd-")), {
    channel: "chromium",
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--host-resolver-rules=MAP chatgpt.com 0.0.0.0"],
  });
  try {
    await mockSites(ctx);
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const before = await sw.evaluate(() => chrome.runtime.getManifest().version);

    // Close the setup page AppLock opens on install (every AppLock page runs the check too).
    const extId = new URL(sw.url()).host;
    await expect.poll(() => ctx.pages().some((p) => p.url().includes(`${extId}/options.html`)), { timeout: 10_000 }).toBe(true);
    await Promise.all(ctx.pages().filter((p) => p.url().includes(extId)).map((p) => p.close()));

    // Simulate an update on disk.
    const mf = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(mf, "utf8"));
    m.version = "99.0.0";
    writeFileSync(mf, JSON.stringify(m, null, 2));

    // chrome.runtime.reload() ends the running background worker. (Under Playwright's
    // --load-extension the extension can't come back afterwards, so this checks the
    // reload is triggered; a normal Chrome restarts it with the new version.)
    const stopped = new Promise<void>((resolve) => sw.once("close", () => resolve()));
    const page = await ctx.newPage();
    // The reload may close things mid-navigation; that's the point.
    for (let i = 0; i < 4; i++) {
      const ok = await page.goto("https://chatgpt.com/").then(() => page.locator("#sidebar").count()).catch(() => 1);
      if (ok) break;
    }
    await expect(Promise.race([stopped.then(() => "reloaded"), new Promise((r) => setTimeout(() => r("still running"), 15_000))])).resolves.toBe("reloaded");
    expect(before).not.toBe("99.0.0");
  } finally {
    await ctx.close();
  }
});

test("an up-to-date extension does not reload itself", async () => {
  const { dir } = testExtension();
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "applock-upd2-")), {
    channel: "chromium",
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, "--host-resolver-rules=MAP chatgpt.com 0.0.0.0"],
  });
  try {
    await mockSites(ctx);
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    let closed = false;
    sw.once("close", () => (closed = true));
    const page = await ctx.newPage();
    for (let i = 0; i < 4 && !(await page.locator("#sidebar").count()); i++) await page.goto("https://chatgpt.com/").catch(() => {});
    await page.waitForTimeout(6000);
    expect(closed).toBe(false);
    expect(await sw.evaluate(async () => (await chrome.storage.local.get("updateCheckedAt")).updateCheckedAt > 0)).toBe(true);
  } finally {
    await ctx.close();
  }
});
