import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

// Serves website/ the way Vercel will (cleanUrls, static files), then checks
// content, the interactive demo, tabs, links, layout and dark mode.
const ROOT = resolve(process.cwd(), "website");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".zip": "application/zip",
};
let server: Server;
let base = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file)) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(() => server.close());

async function load(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base + "/");
  await page.waitForLoadState("networkidle").catch(() => {});
  return errors;
}

test("renders without errors and every local link and asset resolves", async ({ page, request }) => {
  const errors = await load(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Some chats are nobody else’s business.");
  const urls = await page.$$eval("a[href^='/'], link[href^='/'], script[src^='/'], img[src^='/']", (els) =>
    els.map((e) => (e as any).href || (e as any).src),
  );
  for (const u of new Set(urls)) expect((await request.get(u)).status(), u).toBe(200);
  const anchors = await page.$$eval("a[href^='#']", (els) => els.map((e) => e.getAttribute("href")!).filter((h) => h.length > 1));
  for (const a of anchors) expect(await page.locator(a).count(), a).toBe(1);
  expect(errors.filter((e) => !/fonts\.g/.test(e))).toEqual([]);
});

test("the download is the real extension package", async ({ request }) => {
  const res = await request.get(base + "/applock-extension.zip");
  expect(res.status()).toBe(200);
  const body = await res.body();
  expect(body.subarray(0, 2).toString()).toBe("PK");
  expect(body.includes(Buffer.from("manifest.json"))).toBe(true);
});

test("hero demo: lock, unlock with Touch ID, lock again", async ({ page }) => {
  await load(page);
  await expect(page.locator("#demo-unlock")).toBeHidden();
  await expect(page.locator("#demo-relock")).toBeHidden();
  // Lock chips stay inside the sidebar.
  const side = (await page.locator(".side").boundingBox())!;
  for (const b of await page.locator(".side .lockit").all()) {
    const box = (await b.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(side.x + side.width);
  }
  const row = page.locator("#demo-list li", { hasText: "Therapy notes" });
  await page.getByRole("button", { name: "Lock “Therapy notes, week 6”" }).click();
  await expect(row).toHaveClass(/locked/);
  await expect(row).toBeHidden();
  await expect(page.locator("#demo-status")).toHaveText("1 chat is hidden. Anyone else sees only the rest.");
  await page.getByRole("button", { name: "Unlock with Touch ID" }).click();
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/revealed/);
  await page.getByRole("button", { name: "Lock again" }).click();
  await expect(row).toBeHidden();
});

test("install tabs work with mouse and keyboard", async ({ page }) => {
  await load(page);
  await expect(page.locator("#panel-cc")).toBeVisible();
  await page.getByRole("tab", { name: "ChatGPT" }).click();
  await expect(page.locator("#panel-gpt")).toBeVisible();
  await expect(page.locator("#panel-cc")).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Other clients" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Other clients" })).toBeFocused();
});

for (const [name, size] of [["desktop", { width: 1360, height: 900 }], ["mobile", { width: 375, height: 812 }]] as const) {
  test(`no horizontal scroll and screenshots: ${name}`, async ({ page }) => {
    await page.setViewportSize(size);
    await load(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/site-${name}.png`, fullPage: false });
    await page.screenshot({ path: `test-results/site-${name}-full.png`, fullPage: true });
  });
}

test("dark mode uses the dark palette", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1360, height: 900 });
  await load(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(16, 21, 30)");
  await page.screenshot({ path: "test-results/site-dark.png" });
});
