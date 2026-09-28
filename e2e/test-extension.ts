import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Copies the extension to a temp folder and points its MCP bridge at `port`.
 * A copy gets its own extension id and never talks to a real AppLock server
 * that may be running on this machine on the default port 47521.
 */
export function testExtension(port = 40000 + Math.floor(Math.random() * 20000)) {
  const dir = mkdtempSync(join(tmpdir(), "applock-ext-"));
  cpSync(resolve(process.cwd(), "extension"), dir, { recursive: true });
  for (const f of ["background.js", "manifest.json"]) {
    const p = join(dir, f);
    writeFileSync(p, readFileSync(p, "utf8").replaceAll("127.0.0.1:47521", `127.0.0.1:${port}`));
  }
  return { dir, port };
}

/**
 * Sets the extension password through the setup page the extension opens itself
 * on first install (opening a second copy races with it).
 */
export async function setupPassword(ctx: import("@playwright/test").BrowserContext, extId: string, password: string) {
  const url = `chrome-extension://${extId}/options.html`;
  let page = ctx.pages().find((p) => p.url().startsWith(url));
  for (let i = 0; !page && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    page = ctx.pages().find((p) => p.url().startsWith(url));
  }
  if (!page) {
    page = await ctx.newPage();
    await page.goto(url);
  }
  await page.waitForLoadState();
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Repeat password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Save password" }).click();
  await page.getByRole("button", { name: "I’ve saved it" }).click();
  await page.close();
}
