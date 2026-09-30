import "./sites.js";
import "./store.js";

const { SITES, parseChatUrl } = globalThis.AppLockSites;
const store = globalThis.AppLockStore;
store.ready().catch(() => {});
const BRIDGE = "http://127.0.0.1:47521/bridge/sync";
const CHAT_PATTERNS = [
  "https://chatgpt.com/*c/*",
  "https://chat.openai.com/*c/*",
  "https://claude.ai/chat/*",
  "https://gemini.google.com/app/*",
  "https://gemini.google.com/gem/*",
];

// ---- lock store ------------------------------------------------------------------

function getLocked() {
  return store.getLocked();
}

async function lockChat({ site, id, title }) {
  if (!site || !id) throw new Error("Not a chat");
  const auth = await store.getAuth();
  if (!auth?.hash) {
    chrome.runtime.openOptionsPage();
    throw new Error("Set a password in AppLock first.");
  }
  const lock = await store.addLock({ site, id, title: (title || "").slice(0, 200) });
  // Locking always re-hides everything, like closing a locked note.
  await chrome.storage.local.set({ unlockedUntil: 0 });
  if (SITES.find((s) => s.key === site)?.serverArchive && (await store.getPrefs()).archiveOnLock) {
    await store.queueServerOp(site, id, true);
  }
  return { ...lock, title: lock.title || id };
}

async function unlockChat({ site, id }) {
  const { unlockedUntil = 0 } = await chrome.storage.local.get("unlockedUntil");
  // Removing a lock is only allowed while the user has authenticated.
  if (Date.now() >= unlockedUntil) throw new Error("Unlock AppLock first.");
  const lock = (await store.getLocked())[`${site}:${id}`];
  const pending = (await store.pendingServerOps(site)).find((o) => o.id === id);
  await store.removeLock(site, id);
  // Put the chat back in the provider's chat list if AppLock archived it.
  if (pending?.archived && !lock?.archived) await store.clearServerOp(site, id);
  else if (lock?.archived) await store.queueServerOp(site, id, false);
}

// ---- move to vault --------------------------------------------------------------------

async function tabFor(site) {
  const patterns = site.hosts.map((h) => `https://${h}/*`);
  let [tab] = await chrome.tabs.query({ url: patterns });
  if (!tab) tab = await chrome.tabs.create({ url: `https://${site.hosts[0]}/`, active: false });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await chrome.tabs.sendMessage(tab.id, { type: "ping" }))?.site === site.key) return tab;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Couldn't reach ${site.name} in the browser. Open it and try again.`);
}

async function inTab(tab, msg) {
  const r = await chrome.tabs.sendMessage(tab.id, msg);
  if (!r?.ok) throw new Error(r?.error || "No answer from the page.");
  return r.value;
}

/**
 * Saves the whole chat, encrypted, in the AppLock vault on this computer, then
 * deletes it at the provider so it is gone from every device and app. The chat is
 * only deleted after the vault confirms the copy is stored.
 */
async function moveToVault({ site: siteKey, id }) {
  const { unlockedUntil = 0 } = await chrome.storage.local.get("unlockedUntil");
  if (Date.now() >= unlockedUntil) throw new Error("Unlock AppLock first.");
  return saveToVault(siteKey, id, { deleteAfter: true });
}

/**
 * Saves the whole chat, encrypted, in the AppLock vault on this computer. With
 * deleteAfter it then deletes the chat at the provider, only once the vault has
 * confirmed the copy is stored.
 */
async function saveToVault(siteKey, id, { deleteAfter }) {
  const site = SITES.find((s) => s.key === siteKey);
  if (!site || !["chatgpt", "claude"].includes(site.key)) throw new Error(`Saving ${site?.name ?? siteKey} chats to the vault isn't supported.`);
  const tab = await tabFor(site);
  const chat = await inTab(tab, { type: "exportChat", id });
  if (!chat.messages.length) throw new Error("That chat has no messages to save.");
  let saved;
  try {
    const res = await fetch(BRIDGE.replace("/bridge/sync", "/bridge/vault"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: site.key, id, title: chat.title, url: site.chatUrl(id), messages: chat.messages }),
    });
    saved = await res.json();
    if (!res.ok) throw new Error(saved?.error || `status ${res.status}`);
  } catch (e) {
    throw new Error(`The AppLock vault on this computer didn't save it (${e.message}). Nothing was deleted. Is the AppLock MCP server running?`);
  }
  if (deleteAfter) {
    await inTab(tab, { type: "deleteChat", id });
    await store.removeLock(site.key, id).catch(() => {});
    await store.clearServerOp(site.key, id).catch(() => {});
  }
  const { vaulted = [] } = await chrome.storage.local.get("vaulted");
  vaulted.unshift({ site: site.key, id, title: chat.title, vaultId: saved.vaultId, at: Date.now(), deleted: !!deleteAfter });
  await chrome.storage.local.set({ vaulted: vaulted.slice(0, 500) });
  return { vaultId: saved.vaultId, messages: chat.messages.length, title: chat.title };
}

/** Archives every locked chat that isn't archived yet (after turning the setting on). */
async function archiveExistingLocks() {
  const locked = Object.values(await store.getLocked());
  let n = 0;
  for (const l of locked) {
    if (SITES.find((s) => s.key === l.site)?.serverArchive && !l.archived) {
      await store.queueServerOp(l.site, l.id, true);
      n++;
    }
  }
  return n;
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
  const auth = await store.getAuth().catch(() => undefined);
  // On a second computer the password arrives through Chrome sync, so no setup is needed.
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
      case "moveToVault":
        return moveToVault(msg);
      case "archiveExisting":
        return archiveExistingLocks();
      case "openRecovery":
        return chrome.tabs.create({ url: chrome.runtime.getURL("options.html#recover") });
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
    const lockedList = Object.values(locked);
    const body = {
      lockedCount: lockedList.length,
      results,
      phone: {
        hiding: (await store.getPrefs()).archiveOnLock,
        archived: lockedList.filter((l) => l.archived).length,
        pending: (await store.pendingServerOps("chatgpt")).length,
        chatgptLocked: lockedList.filter((l) => l.site === "chatgpt").length,
      },
    };
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
          // "everywhere": also archive on the provider (hides it in the phone apps).
          if (cmd.archive && SITES.find((s) => s.key === chat.site)?.serverArchive && !(await store.getPrefs()).archiveOnLock) {
            await store.queueServerOp(chat.site, chat.id, true);
          }
          results.push({ id: cmd.id, ok: true, chat: { site: chat.site, id: chat.id, title: chat.title } });
        } else if (cmd.action === "vaultCopy") {
          // Copies transcripts into the vault without deleting anything at the provider.
          const locked = Object.values(await getLocked()).filter((l) => ["chatgpt", "claude"].includes(l.site));
          const targets = cmd.chatId === "locked" ? locked : [{ site: cmd.site, id: cmd.chatId }];
          const done = [];
          const errors = [];
          for (const t of targets) {
            try {
              done.push({ site: t.site, ...(await saveToVault(t.site, t.id, { deleteAfter: false })) });
            } catch (e) {
              errors.push({ site: t.site, id: t.id, error: e.message });
            }
          }
          results.push({ id: cmd.id, ok: errors.length === 0 || done.length > 0, detail: { saved: done.map((d) => ({ site: d.site, title: d.title, messages: d.messages })), errors } });
        } else if (cmd.action === "phoneHiding") {
          // Hiding more strongly is allowed from the MCP server; revealing never is.
          await store.setPrefs({ archiveOnLock: !!cmd.on });
          const queued = cmd.on && cmd.applyToLocked ? await archiveExistingLocks() : 0;
          results.push({ id: cmd.id, ok: true, detail: { on: !!cmd.on, queued } });
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
