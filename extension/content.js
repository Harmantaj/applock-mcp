// Runs on ChatGPT / Claude / Gemini. Hides locked chats from every list on the
// page and covers a locked chat with a lock screen when it is opened directly.
(() => {
  const { siteForHost, parseChatUrl, keyOf } = globalThis.AppLockSites;
  const site = siteForHost(location.hostname);
  if (!site) return;

  let locked = {};
  let unlockedUntil = 0;
  let overlay;
  let realTitle = "";
  let lastReport = "";
  let expiryTimer;

  const isUnlocked = () => Date.now() < unlockedUntil;
  const lockedIds = () => Object.values(locked).filter((l) => l.site === site.key).map((l) => l.id);

  // ---- instant, pre-paint hiding via CSS ---------------------------------------
  const style = document.createElement("style");
  style.id = "applock-style";
  (document.head || document.documentElement).appendChild(style);

  function writeCss() {
    if (isUnlocked()) return void (style.textContent = "");
    style.textContent = lockedIds()
      .map((id) => `a[href$="/${CSS.escape(id)}"],a[href*="/${CSS.escape(id)}?"],a[href*="/${CSS.escape(id)}/"]`)
      .join(",\n")
      .concat(lockedIds().length ? "{display:none!important}" : "");
  }

  // ---- DOM pass: hide the whole row, not just the link -----------------------------
  const STOP = new Set(["NAV", "OL", "UL", "ASIDE", "MAIN", "BODY", "HTML", "SECTION"]);

  function rowFor(a) {
    const li = a.closest("li");
    if (li && li.querySelectorAll(site.linkSelector).length === 1) return li;
    let el = a;
    for (let i = 0; i < 3; i++) {
      const p = el.parentElement;
      if (!p || STOP.has(p.tagName) || p.children.length !== 1) break;
      el = p;
    }
    return el;
  }

  function apply() {
    writeCss();
    const lockedSet = new Set(lockedIds());
    const unlocked = isUnlocked();
    document.querySelectorAll("[data-applock-hidden],[data-applock-reveal]").forEach((el) => {
      el.removeAttribute("data-applock-hidden");
      el.removeAttribute("data-applock-reveal");
    });
    for (const a of document.querySelectorAll(site.linkSelector)) {
      const hit = parseChatUrl(a.href);
      if (!hit || !lockedSet.has(hit.id)) continue;
      rowFor(a).setAttribute(unlocked ? "data-applock-reveal" : "data-applock-hidden", "");
    }
    const here = parseChatUrl(location.href);
    if (here && lockedSet.has(here.id) && !unlocked) showOverlay(here);
    else hideOverlay();
    report();
  }

  // ---- lock screen -------------------------------------------------------------
  function showOverlay(chat) {
    if (overlay?.dataset.chat === chat.id) return;
    hideOverlay();
    realTitle = document.title;
    overlay = document.createElement("div");
    overlay.id = "applock-overlay";
    overlay.dataset.chat = chat.id;
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    const root = overlay.attachShadow({ mode: "closed" });
    const frame = chrome.runtime.getURL(`unlock.html?embedded=1&site=${chat.site}&id=${encodeURIComponent(chat.id)}`);
    root.innerHTML = `<style>
      .veil{position:fixed;inset:0;display:grid;place-items:center;background:rgba(12,12,16,.94);backdrop-filter:blur(28px) saturate(.6);-webkit-backdrop-filter:blur(28px)}
      iframe{width:min(380px,92vw);height:430px;border:0;border-radius:20px;background:transparent;color-scheme:normal}
    </style><div class="veil"><iframe allow="publickey-credentials-get *" title="Unlock chat"></iframe></div>`;
    root.querySelector("iframe").src = frame;
    document.documentElement.appendChild(overlay);
    document.documentElement.setAttribute("data-applock-locked", "");
    if (document.body) document.body.inert = true;
    document.title = "Locked chat";
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = undefined;
    document.documentElement.removeAttribute("data-applock-locked");
    if (document.body) document.body.inert = false;
    if (document.title === "Locked chat" && realTitle) document.title = realTitle;
  }

  // Keep the tab title masked while the lock screen is up.
  new MutationObserver(() => {
    if (overlay && document.title !== "Locked chat") {
      realTitle = document.title;
      document.title = "Locked chat";
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  // ---- reporting to the service worker (feeds the MCP bridge) -------------------
  function titleOf(a) {
    return (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function currentChat() {
    const here = parseChatUrl(location.href);
    if (!here) return null;
    const link = [...document.querySelectorAll(site.linkSelector)].find((a) => parseChatUrl(a.href)?.id === here.id);
    const title = (link && titleOf(link)) || (overlay ? realTitle : document.title) || here.id;
    return { ...here, title, url: location.href };
  }

  function report(force = false) {
    if (document.visibilityState !== "visible") return;
    const lockedSet = new Set(lockedIds());
    const seen = new Set();
    const chats = [];
    for (const a of document.querySelectorAll(site.linkSelector)) {
      const hit = parseChatUrl(a.href);
      if (!hit || seen.has(hit.id) || lockedSet.has(hit.id)) continue;
      seen.add(hit.id);
      const title = titleOf(a);
      if (title) chats.push({ ...hit, title });
      if (chats.length >= 300) break;
    }
    const active = currentChat();
    const payload = { active: active && lockedSet.has(active.id) ? null : active, chats };
    const sig = JSON.stringify(payload);
    if (!force && sig === lastReport) return;
    lastReport = sig;
    chrome.runtime.sendMessage({ type: "report", site: site.key, ...payload }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "getCurrentChat") reply(currentChat());
    if (msg.type === "titleFor") {
      const a = [...document.querySelectorAll(site.linkSelector)].find((x) => parseChatUrl(x.href)?.id === msg.id);
      reply(a ? titleOf(a) : null);
    }
  });

  // ---- state -----------------------------------------------------------------
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (isUnlocked()) expiryTimer = setTimeout(apply, unlockedUntil - Date.now() + 50);
  }

  chrome.storage.local.get(["locked", "unlockedUntil"]).then((s) => {
    locked = s.locked ?? {};
    unlockedUntil = s.unlockedUntil ?? 0;
    scheduleExpiry();
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.locked) locked = changes.locked.newValue ?? {};
    if (changes.unlockedUntil) unlockedUntil = changes.unlockedUntil.newValue ?? 0;
    if (changes.locked || changes.unlockedUntil) {
      scheduleExpiry();
      apply();
    }
  });

  // SPAs re-render constantly; batch DOM passes.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      apply();
    }, 60);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Client-side navigation doesn't fire any event the isolated world can hook.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      apply();
    }
  }, 250);
  // Heartbeat so the MCP bridge sees the extension while a chat tab is open.
  setInterval(() => report(true), 4000);
  document.addEventListener("visibilitychange", () => report(true));
})();
