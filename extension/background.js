import "./sites.js";

const { SITES, parseChatUrl, keyOf } = globalThis.AppLockSites;
const BRIDGE = "http://127.0.0.1:47521/bridge/sync";
const CHAT_PATTERNS = [
  "https://chatgpt.com/*c/*",
  "https://chat.openai.com/*c/*",
  "https://claude.ai/chat/*",
  "https://gemini.google.com/app/*",
  "https://gemini.google.com/gem/*",
];

// ---- lock store ------------------------------------------------------------------

async function getLocked() {
  return (await chrome.storage.local.get("locked")).locked ?? {};
}

async function lockChat({ site, id, title }) {
  if (!site || !id) throw new Error("Not a chat");
  const { auth } = await chrome.storage.local.get("auth");
  if (!auth?.hash) {
    chrome.runtime.openOptionsPage();
    throw new Error("Set a password in AppLock first.");
  }
  const locked = await getLocked();
  locked[keyOf(site, id)] = { site, id, title: (title || id).slice(0, 200), lockedAt: Date.now() };
  // Locking always re-hides everything, like closing a locked note.
  await chrome.storage.local.set({ locked, unlockedUntil: 0 });
  return locked[keyOf(site, id)];
}

async function unlockChat({ site, id }) {
  const { unlockedUntil = 0 } = await chrome.storage.local.get("unlockedUntil");
  // Removing a lock is only allowed while the user has authenticated.
  if (Date.now() >= unlockedUntil) throw new Error("Unlock AppLock first.");
  const locked = await getLocked();
  delete locked[keyOf(site, id)];
  await chrome.storage.local.set({ locked });
}

async function titleFromTab(tabId, id) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "titleFor", id });
  } catch {
    return null;
  }
}

// ---- lifecycle -------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "lock-link", title: "Lock this chat with AppLock", contexts: ["link"], targetUrlPatterns: CHAT_PATTERNS });
    chrome.contextMenus.create({ id: "lock-page", title: "Lock this chat with AppLock", contexts: ["page"], documentUrlPatterns: CHAT_PATTERNS });
  });
  chrome.alarms.create("bridge", { periodInMinutes: 0.5 });
  const { auth } = await chrome.storage.local.get("auth");
  if (reason === "install" && !auth?.hash) chrome.runtime.openOptionsPage();
});

// A browser restart always starts locked.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.set({ unlockedUntil: 0 }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.unlockedUntil) {
    const until = changes.unlockedUntil.newValue ?? 0;
    chrome.alarms.clear("relock");
    if (until > Date.now()) chrome.alarms.create("relock", { when: until });
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "relock") chrome.storage.local.set({ unlockedUntil: 0 });
  if (a.name === "bridge") syncBridge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === "lock-link" ? info.linkUrl : info.pageUrl;
  const hit = parseChatUrl(url);
  if (!hit) return;
  const title = (tab && (await titleFromTab(tab.id, hit.id))) || (info.menuItemId === "lock-link" ? info.selectionText : tab?.title);
  await lockChat({ ...hit, title }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "relock") return chrome.storage.local.set({ unlockedUntil: 0 });
  if (command === "lock-current") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hit = tab?.url && parseChatUrl(tab.url);
    if (!hit) return;
    const chat = await chrome.tabs.sendMessage(tab.id, { type: "getCurrentChat" }).catch(() => null);
    await lockChat({ ...hit, title: chat?.title ?? tab.title }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = async () => {
    switch (msg.type) {
      case "lock":
        return lockChat(msg);
      case "unlockChat":
        return unlockChat(msg);
      case "open": {
        const site = SITES.find((s) => s.key === msg.site);
        return chrome.tabs.create({ url: site.chatUrl(msg.id) });
      }
      case "goHome": {
        const site = SITES.find((s) => s.key === msg.site);
        if (sender.tab?.id && site) return chrome.tabs.update(sender.tab.id, { url: `https://${site.hosts[0]}/` });
        return;
      }
      case "report":
        lastReport = { active: msg.active, chats: msg.chats, site: msg.site, at: Date.now() };
        return syncBridge();
    }
  };
  run().then(
    (v) => reply({ ok: true, value: v }),
    (e) => reply({ ok: false, error: e.message }),
  );
  return true;
});

// ---- MCP bridge (lock-only) --------------------------------------------------------

let lastReport = null;
let results = [];
let syncing = false;
let lastSync = 0;

async function syncBridge() {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings?.bridge === false || syncing || Date.now() - lastSync < 1500) return;
  syncing = true;
  lastSync = Date.now();
  try {
    const locked = await getLocked();
    const body = { lockedCount: Object.keys(locked).length, results };
    if (lastReport && Date.now() - lastReport.at < 15000) {
      body.active = lastReport.active;
      body.chats = lastReport.chats;
    } else body.active = null;
    const res = await fetch(BRIDGE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return;
    results = [];
    await chrome.storage.local.set({ bridgeSeen: Date.now() });
    const { commands = [] } = await res.json();
    for (const cmd of commands) {
      try {
        if (cmd.action === "lock") {
          const title = lastReport?.chats?.find((c) => c.id === cmd.chatId)?.title ?? (lastReport?.active?.id === cmd.chatId ? lastReport.active.title : undefined);
          const chat = await lockChat({ site: cmd.site, id: cmd.chatId, title });
          results.push({ id: cmd.id, ok: true, chat: { site: chat.site, id: chat.id, title: chat.title } });
        } else if (cmd.action === "relock") {
          await chrome.storage.local.set({ unlockedUntil: 0 });
          results.push({ id: cmd.id, ok: true });
        } else {
          // The bridge is deliberately unable to reveal anything.
          results.push({ id: cmd.id, ok: false, error: `Action "${cmd.action}" is not allowed from the MCP server` });
        }
      } catch (e) {
        results.push({ id: cmd.id, ok: false, error: e.message });
      }
    }
    if (results.length) {
      syncing = false;
      lastSync = 0;
      return syncBridge();
    }
  } catch {
    // MCP server isn't running; that's fine.
  } finally {
    syncing = false;
  }
}
