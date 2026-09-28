// Runs on ChatGPT / Claude / Gemini. Hides locked chats from every list on the
// page and covers a locked chat with a lock screen when it is opened directly.
(() => {
  const { siteForHost, parseChatUrl, keyOf } = globalThis.AppLockSites;
  const store = globalThis.AppLockStore;
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

  /** The whole sidebar row for a chat link: the largest ancestor (up to 4 levels)
   * that still contains only this one chat link. Works for ChatGPT's <li> rows,
   * Claude's <div> rows (link + menu button) and Gemini's conversation items. */
  function rowFor(a) {
    let el = a;
    for (let i = 0; i < 4; i++) {
      const p = el.parentElement;
      if (!p || STOP.has(p.tagName)) break;
      let chats = 0;
      for (const x of p.querySelectorAll(site.linkSelector)) if (parseChatUrl(x.href) && ++chats > 1) break;
      if (chats !== 1) break;
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
    const learned = {};
    for (const a of document.querySelectorAll(site.linkSelector)) {
      const hit = parseChatUrl(a.href);
      if (!hit || !lockedSet.has(hit.id)) continue;
      rowFor(a).setAttribute(unlocked ? "data-applock-reveal" : "data-applock-hidden", "");
      // Locks made on another computer arrive without a title; pick it up here.
      const t = titleOf(a);
      const key = keyOf(site.key, hit.id);
      if (t && locked[key] && locked[key].title !== t) learned[key] = t;
    }
    if (Object.keys(learned).length) store.rememberTitles(learned).catch(() => {});
    const here = parseChatUrl(location.href);
    if (here && lockedSet.has(here.id) && !unlocked) showOverlay(here);
    else hideOverlay();
    updateFab();
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
  /** Visible text of a chat link, ignoring buttons inside it (ChatGPT nests its "⋯" menu). */
  function titleOf(a) {
    let text = "";
    const walk = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("button, [role=button]") && a.contains(n.parentElement.closest("button, [role=button]")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) text += n.nodeValue + " ";
    return text.replace(/\s+/g, " ").trim().slice(0, 120);
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

  // ---- lock button for phones (no shortcuts or right-click there) ---------------------
  let fab;
  async function updateFab() {
    const { settings = {} } = await chrome.storage.local.get("settings");
    const mode = settings.lockButton ?? "auto"; // auto = touch screens only
    const want = mode === "always" || (mode === "auto" && matchMedia("(pointer: coarse)").matches);
    const here = parseChatUrl(location.href);
    const show = want && here && !locked[keyOf(site.key, here.id)] && !overlay;
    if (!show) return void fab?.remove();
    if (fab?.isConnected) return;
    fab = document.createElement("div");
    fab.id = "applock-fab";
    const root = fab.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      button{position:fixed;right:14px;bottom:calc(88px + env(safe-area-inset-bottom));z-index:2147483646;width:44px;height:44px;border-radius:22px;border:0;
        background:#3a3f9e;color:#fff;font-size:20px;box-shadow:0 6px 18px rgba(0,0,0,.25);touch-action:manipulation}
      button:focus-visible{outline:3px solid #8f95ff;outline-offset:2px}
    </style><button type="button" aria-label="Lock this chat with AppLock">🔒</button>`;
    root.querySelector("button").addEventListener("click", async () => {
      const chat = currentChat();
      if (chat) await chrome.runtime.sendMessage({ type: "lock", ...chat });
    });
    document.documentElement.appendChild(fab);
  }

  // ---- server-side archive (ChatGPT) ----------------------------------------------
  // Uses the same endpoints as ChatGPT's own Archive / Unarchive menu items, with
  // the signed-in session of this tab. Jobs come from any of the user's computers.
  let opsRunning = false;
  async function runServerOps() {
    if (!site.serverArchive || opsRunning) return;
    opsRunning = true;
    // One tab per browser does the work: take a short lease in local storage.
    const me = Math.random().toString(36).slice(2);
    let leased = false;
    let seen = new Set();
    try {
      const ops = await store.pendingServerOps(site.key);
      seen = new Set(ops.map((o) => `${o.id}:${o.at}`));
      if (!ops.length) return;
      const { opsLease } = await chrome.storage.local.get("opsLease");
      if (opsLease && opsLease.until > Date.now()) return;
      await chrome.storage.local.set({ opsLease: { owner: me, until: Date.now() + 20000 } });
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      if ((await chrome.storage.local.get("opsLease")).opsLease?.owner !== me) return;
      leased = true;
      // Firefox runs content-script fetch with the extension's origin; content.fetch
      // makes the request as the page itself, like Chrome does by default.
      const pageFetch = typeof content !== "undefined" && content?.fetch ? content.fetch.bind(content) : fetch;
      const session = await pageFetch("/api/auth/session", { credentials: "include" }).then((r) => (r.ok ? r.json() : null));
      const token = session?.accessToken;
      if (!token) return; // signed out: try again later
      for (const op of ops) {
        const res = await pageFetch(`/backend-api/conversation/${encodeURIComponent(op.id)}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ is_archived: op.archived }),
        });
        if (res.ok || res.status === 404) {
          await store.clearServerOp(site.key, op.id);
          if (res.ok) await store.markArchived(site.key, op.id, op.archived);
        }
      }
    } catch {
      // Network hiccup: the jobs stay queued for next time.
    } finally {
      if (leased) await chrome.storage.local.remove("opsLease").catch(() => {});
      opsRunning = false;
      // Jobs that arrived while this run held the lease are picked up next time.
      // (Failed ones wait for the next page load or change, so a down server isn't hammered.)
      if (leased)
        store
          .pendingServerOps(site.key)
          .then((o) => o.some((x) => !seen.has(`${x.id}:${x.at}`)) && setTimeout(runServerOps, 500))
          .catch(() => {});
    }
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

  Promise.all([store.getLocked(), chrome.storage.local.get("unlockedUntil")]).then(([l, s]) => {
    locked = l;
    unlockedUntil = s.unlockedUntil ?? 0;
    scheduleExpiry();
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.keys(changes).some((k) => k.startsWith(`op:${site.key}:`))) runServerOps();
  });
  if (site.serverArchive) setTimeout(runServerOps, 1500);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) updateFab();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    const lockChange = store.locksChanged(changes, area);
    const timeChange = area === "local" && !!changes.unlockedUntil;
    if (timeChange) unlockedUntil = changes.unlockedUntil.newValue ?? 0;
    if (lockChange) locked = await store.getLocked();
    if (lockChange || timeChange) {
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
