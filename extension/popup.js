import "./sites.js";
import "./store.js";
import { getAuth, relockNow, startUnlockedSession, verifyPassword, verifyTouchId } from "./auth.js";

const { parseChatUrl, SITES } = globalThis.AppLockSites;
const $ = (id) => document.getElementById(id);
const siteName = (k) => SITES.find((s) => s.key === k)?.name ?? k;

let current; // { site, id, title }

async function render() {
  const auth = await getAuth();
  const locked = await globalThis.AppLockStore.getLocked();
  const { unlockedUntil = 0, bridgeSeen = 0 } = await chrome.storage.local.get(["unlockedUntil", "bridgeSeen"]);
  const unlocked = Date.now() < unlockedUntil;
  $("setup").hidden = !!auth?.hash;
  $("main").hidden = !auth?.hash;
  const mins = Math.max(1, Math.ceil((unlockedUntil - Date.now()) / 60000));
  $("state").textContent = unlocked ? `Unlocked · ${mins} min` : "Locked";
  $("state").classList.toggle("open", unlocked);
  $("touch").hidden = !auth?.credential;
  $("unlockCard").hidden = unlocked || Object.keys(locked).length === 0;
  $("lockedCard").hidden = !unlocked;
  $("bridge").textContent = Date.now() - bridgeSeen < 30000 ? "MCP: connected" : "MCP: not connected";

  if (current) {
    const isLocked = !!locked[`${current.site}:${current.id}`];
    $("curTitle").textContent = isLocked ? `“${locked[`${current.site}:${current.id}`].title || current.title}” is locked.` : `“${current.title}” on ${siteName(current.site)}`;
    $("curTitle").classList.toggle("muted", false);
    $("lockBtn").hidden = isLocked;
    $("unlockBtn").hidden = !isLocked || !unlocked;
  }

  const list = $("lockedList");
  list.replaceChildren();
  const items = Object.values(locked).sort((a, b) => b.lockedAt - a.lockedAt);
  if (!items.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="t muted">No locked chats yet.</span>`;
    list.append(li);
  }
  for (const item of items) {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    // Locks made on another computer have no title here until the chat is seen once.
    const title = item.title || `${siteName(item.site)} chat ${item.id.slice(0, 8)}`;
    t.textContent = title;
    t.title = title;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = siteName(item.site);
    const open = document.createElement("button");
    open.className = "link";
    open.textContent = "Open";
    open.onclick = () => chrome.runtime.sendMessage({ type: "open", site: item.site, id: item.id });
    const rm = document.createElement("button");
    rm.className = "link";
    rm.textContent = "Unlock";
    rm.setAttribute("aria-label", `Remove lock from ${title}`);
    rm.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "unlockChat", site: item.site, id: item.id });
      render();
    };
    li.append(t, badge, open, rm);
    list.append(li);
  }
}

async function findCurrent() {
  // ?tab=<id> lets the end-to-end tests point the popup at a specific tab.
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const hit = tab?.url && parseChatUrl(tab.url);
  if (!hit) return;
  let title = tab.title || hit.id;
  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: "getCurrentChat" });
    if (info?.title) title = info.title;
  } catch {}
  current = { ...hit, title };
}

function err(e) {
  $("err").textContent = e?.name === "NotAllowedError" ? "Touch ID was cancelled." : e?.message ?? String(e);
}

$("openSetup").onclick = () => chrome.runtime.openOptionsPage();
$("forgot").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("options.html#recover") });
$("settings").onclick = () => chrome.runtime.openOptionsPage();
$("lockBtn").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "lock", ...current });
  render();
};
$("unlockBtn").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "unlockChat", site: current.site, id: current.id });
  render();
};
$("relock").onclick = async () => {
  await relockNow();
  render();
};
$("touch").onclick = async () => {
  try {
    await verifyTouchId();
    await startUnlockedSession();
    render();
  } catch (e) {
    err(e);
  }
};
$("pwForm").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    await verifyPassword($("pw").value);
    $("pw").value = "";
    $("err").textContent = "";
    await startUnlockedSession();
    render();
  } catch (e) {
    err(e);
  }
};

await findCurrent();
render();
chrome.storage.onChanged.addListener(render);
