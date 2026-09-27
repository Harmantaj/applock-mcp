// Hero demo: lock chats in a pretend sidebar, then unlock them.
(() => {
  const list = document.getElementById("demo-list");
  const pane = document.getElementById("demo-pane");
  const status = document.getElementById("demo-status");
  const unlockBtn = document.getElementById("demo-unlock");
  const relockBtn = document.getElementById("demo-relock");
  if (!list) return;

  const lockSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

  function update() {
    const locked = list.querySelectorAll("li.locked, li.revealed").length;
    const revealed = list.querySelector("li.revealed");
    const sensitiveVisible = list.querySelectorAll("li.sensitive:not(.locked):not(.revealed)").length;
    unlockBtn.hidden = locked === 0 || !!revealed;
    relockBtn.hidden = !revealed;
    if (revealed) status.textContent = "Unlocked. Locked chats show up until you lock again.";
    else if (locked) status.textContent = `${locked} ${locked === 1 ? "chat is" : "chats are"} hidden. Anyone else sees only the rest.`;
    else status.textContent = `${sensitiveVisible} chats visible that you probably want hidden.`;
  }

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".lockit");
    if (!btn) return;
    btn.closest("li").classList.add("locked");
    pane.innerHTML = `<div class="lockcard">${lockSvg}<strong>Chat locked</strong><span>It’s gone from the sidebar. Opening its link shows a lock screen.</span></div>`;
    update();
  });

  unlockBtn.addEventListener("click", () => {
    list.querySelectorAll("li.locked").forEach((li) => {
      li.classList.remove("locked");
      li.classList.add("revealed");
    });
    pane.innerHTML = `<div class="lockcard">${lockSvg}<strong>Unlocked</strong><span>Touch ID confirmed it’s you.</span></div>`;
    update();
  });

  relockBtn.addEventListener("click", () => {
    list.querySelectorAll("li.revealed").forEach((li) => {
      li.classList.remove("revealed");
      li.classList.add("locked");
    });
    pane.innerHTML = `<p class="pane-hint">Locked again. It also happens on its own after a few minutes.</p>`;
    update();
  });
})();

// Accessible tabs for the install section.
document.querySelectorAll("[data-tabs]").forEach((root) => {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
    tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") select(tabs[(i + 1) % tabs.length]);
      if (e.key === "ArrowLeft") select(tabs[(i - 1 + tabs.length) % tabs.length]);
    });
  });
});
