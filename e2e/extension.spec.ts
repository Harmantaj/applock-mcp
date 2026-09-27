import { test as base, expect, chromium, type BrowserContext, type Frame, type Page, type Worker } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHATGPT_CHATS, CLAUDE_CHATS, GEMINI_CHATS, mockSites } from "./mock-sites";

const EXT = resolve(process.cwd(), "extension");
const PASSWORD = "open sesame";

type Fixtures = { ctx: BrowserContext; sw: Worker; extId: string };

// One browser profile shared across the file, like a real user's browser.
export const test = base.extend<{}, Fixtures>({
  ctx: [
    async ({}, use) => {
      const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "applock-pw-")), {
        channel: "chromium",
        args: [
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`,
          // Never reach the real sites if a request slips past the mocks.
          "--host-resolver-rules=MAP chatgpt.com 0.0.0.0, MAP claude.ai 0.0.0.0, MAP gemini.google.com 0.0.0.0",
        ],
      });
      await mockSites(ctx);
      await use(ctx);
      await ctx.close();
    },
    { scope: "worker" },
  ],
  sw: [
    async ({ ctx }, use) => {
      let [sw] = ctx.serviceWorkers();
      sw ??= await ctx.waitForEvent("serviceworker");
      await use(sw);
    },
    { scope: "worker" },
  ],
  extId: [async ({ sw }, use) => use(new URL(sw.url()).host), { scope: "worker" }],
});

/** Navigates and retries if Chrome's internal redirect skipped the route mock. */
async function open(page: Page, url: string) {
  for (let i = 0; i < 4; i++) {
    await page.goto(url).catch(() => {});
    if (await page.locator("#sidebar").count()) return;
  }
  throw new Error(`Mock page did not load for ${url}`);
}

const sidebarLink = (page: Page, title: string) => page.locator("nav a", { hasText: title });
// The lock screen lives in a closed shadow root (so the page can't reach it);
// Playwright can still address the unlock iframe as a frame.
async function lockFrame(page: Page): Promise<Frame> {
  let f: Frame | undefined;
  await expect.poll(() => (f = page.frames().find((x) => x.url().includes("/unlock.html"))), { timeout: 7000 }).toBeTruthy();
  await f!.waitForLoadState();
  return f!;
}

async function tabIdFor(sw: Worker, pattern: string) {
  return sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0]?.id, pattern);
}

test.describe.configure({ mode: "serial" });

test("first install opens setup; a password can be saved", async ({ ctx: context, extId }) => {
  let setup: Page | undefined;
  await expect
    .poll(() => (setup = context.pages().find((p) => p.url().includes(`${extId}/options.html`))), { timeout: 10_000 })
    .toBeTruthy();
  setup = setup!;
  await setup.waitForLoadState();
  await expect(setup.getByRole("heading", { name: "1 · Choose a password" })).toBeVisible();
  await setup.getByLabel("New password").fill(PASSWORD);
  await setup.getByLabel("Repeat password").fill("typo");
  await setup.getByRole("button", { name: "Save password" }).click();
  await expect(setup.locator("#pwErr")).toHaveText("The passwords don't match.");
  await setup.getByLabel("Repeat password").fill(PASSWORD);
  await setup.getByRole("button", { name: "Save password" }).click();
  await expect(setup.locator("#pwOk")).toHaveText("Saved.");
  await expect(setup.getByRole("button", { name: "Change password" })).toBeVisible();
  await setup.close();
});

test("locking a ChatGPT chat from the popup hides it from the sidebar", async ({ ctx: context, sw, extId }) => {
  const [secret, other] = CHATGPT_CHATS;
  const chat = await context.newPage();
  await open(chat, `https://chatgpt.com/c/${secret.id}`);
  await expect(sidebarLink(chat, secret.title)).toBeVisible();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${await tabIdFor(sw, "https://chatgpt.com/*")}`);
  await expect(popup.locator("#curTitle")).toContainText(secret.title);
  await popup.getByRole("button", { name: "Lock this chat" }).click();
  await expect(popup.locator("#curTitle")).toContainText("is locked");
  await popup.close();

  await expect(sidebarLink(chat, secret.title)).toBeHidden();
  await expect(sidebarLink(chat, other.title)).toBeVisible();
  // It was open, so the lock screen covers it immediately.
  await expect(chat.locator("#applock-overlay")).toBeAttached();
  await expect(chat).toHaveTitle("Locked chat");
  expect(await chat.evaluate(() => document.body.inert)).toBe(true);
  await chat.close();
});

test("a locked chat stays hidden after reload and shows the lock screen if opened by URL", async ({ ctx: context }) => {
  const [secret, other] = CHATGPT_CHATS;
  const page = await context.newPage();
  await open(page, `https://chatgpt.com/c/${other.id}`);
  await expect(sidebarLink(page, other.title)).toBeVisible();
  await expect(sidebarLink(page, secret.title)).toBeHidden();
  await expect(page.locator("#applock-overlay")).toHaveCount(0);

  await open(page, `https://chatgpt.com/c/${secret.id}`);
  const frame = await lockFrame(page);
  await expect(frame.getByRole("heading", { name: "This chat is locked" })).toBeVisible();
  await expect(page).toHaveTitle("Locked chat");
  // The page underneath can't be typed into.
  await expect(page.locator("#composer")).not.toBeEditable({ timeout: 1000 }).catch(() => {});
  expect(await page.evaluate(() => document.body.inert)).toBe(true);
  await page.close();
});

test("wrong password is rejected; the right one reveals chats, then auto-relock hides them", async ({ ctx: context, sw }) => {
  const [secret] = CHATGPT_CHATS;
  const page = await context.newPage();
  await open(page, `https://chatgpt.com/c/${secret.id}`);
  const frame = await lockFrame(page);
  await frame.getByLabel("Password").fill("nope");
  await frame.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(frame.locator("#err")).toHaveText("Wrong password.");

  await frame.getByLabel("Password").fill(PASSWORD);
  await frame.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator("#applock-overlay")).toHaveCount(0);
  await expect(page).toHaveTitle(secret.title);
  expect(await page.evaluate(() => document.body.inert)).toBe(false);
  // Revealed rows are marked with a lock badge while unlocked.
  await expect(page.locator("[data-applock-reveal]")).toHaveCount(1);
  await expect(sidebarLink(page, secret.title)).toBeVisible();

  // Simulate the timer running out.
  await sw.evaluate(() => chrome.storage.local.set({ unlockedUntil: Date.now() + 800 }));
  await expect(page.locator("#applock-overlay")).toBeAttached({ timeout: 5000 });
  await expect(sidebarLink(page, secret.title)).toBeHidden();
  await page.close();
});

test("client-side navigation into a locked chat is caught", async ({ ctx: context }) => {
  const [secret, other] = CHATGPT_CHATS;
  const page = await context.newPage();
  await open(page, `https://chatgpt.com/c/${other.id}`);
  await expect(page.locator("#applock-overlay")).toHaveCount(0);
  await page.evaluate((id) => {
    history.pushState({}, "", `/c/${id}`);
  }, secret.id);
  await expect(page.locator("#applock-overlay")).toBeAttached();
  await page.close();
});

test("Claude.ai and Gemini sidebars are handled too", async ({ ctx: context, sw }) => {
  await sw.evaluate(
    async ({ c, g }) => {
      const { locked = {} } = await chrome.storage.local.get("locked");
      locked[`claude:${c.id}`] = { site: "claude", id: c.id, title: c.title, lockedAt: Date.now() };
      locked[`gemini:${g.id}`] = { site: "gemini", id: g.id, title: g.title, lockedAt: Date.now() };
      await chrome.storage.local.set({ locked });
    },
    { c: CLAUDE_CHATS[0], g: GEMINI_CHATS[0] },
  );
  const claude = await context.newPage();
  await open(claude, "https://claude.ai/new");
  await expect(sidebarLink(claude, CLAUDE_CHATS[0].title)).toBeHidden();
  await expect(claude.locator("li", { hasText: CLAUDE_CHATS[0].title })).toBeHidden();
  await expect(sidebarLink(claude, CLAUDE_CHATS[1].title)).toBeVisible();

  const gemini = await context.newPage();
  await open(gemini, "https://gemini.google.com/app");
  await expect(gemini.locator(".conversation-item", { hasText: GEMINI_CHATS[0].title })).toBeHidden();
  await expect(sidebarLink(gemini, GEMINI_CHATS[1].title)).toBeVisible();
  await open(gemini, `https://gemini.google.com/app/${GEMINI_CHATS[0].id}`);
  await expect(gemini.locator("#applock-overlay")).toBeAttached();
  await claude.close();
  await gemini.close();
});

test("removing a lock needs an unlocked session", async ({ ctx: context, sw, extId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await expect(popup.locator("#lockedCard")).toBeHidden();
  const denied = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: "unlockChat", site: "gemini", id: "a1b2c3d4e5f60001" }),
  );
  expect(denied).toEqual({ ok: false, error: "Unlock AppLock first." });

  await popup.getByLabel("Password").fill(PASSWORD);
  await popup.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(popup.locator("#lockedCard")).toBeVisible();
  await expect(popup.locator("#lockedList li")).toHaveCount(3);
  await popup.getByRole("button", { name: `Remove lock from ${GEMINI_CHATS[0].title}` }).click();
  await expect(popup.locator("#lockedList li")).toHaveCount(2);
  await popup.getByRole("button", { name: "Lock now" }).click();
  await expect(popup.locator("#state")).toHaveText("Locked");
  const locked = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get("locked")).locked));
  expect(locked.sort()).toEqual([`chatgpt:${CHATGPT_CHATS[0].id}`, `claude:${CLAUDE_CHATS[0].id}`].sort());
  await popup.close();
});

test("Touch ID (virtual authenticator) registers and unlocks, with signature verified", async ({ ctx: context, extId }) => {
  const options = await context.newPage();
  const cdp = await context.newCDPSession(options);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.getByRole("button", { name: "Turn on Touch ID" }).click();
  await expect(options.locator("#touchOk")).toHaveText("Touch ID is on.");

  // Same page context (same authenticator): verify via the unlock page.
  await options.goto(`chrome-extension://${extId}/unlock.html`);
  const result = await options.evaluate(async () => {
    const { verifyTouchId } = await import("./auth.js");
    try {
      return await verifyTouchId();
    } catch (e: any) {
      return e.message;
    }
  });
  expect(result).toBe(true);

  // A user who fails verification is refused.
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  const refused = await options.evaluate(async () => {
    const { verifyTouchId } = await import("./auth.js");
    try {
      return await verifyTouchId();
    } catch (e: any) {
      return e.name || e.message;
    }
  });
  expect(refused).not.toBe(true);
  await options.close();
});
