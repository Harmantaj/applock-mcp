// Where AppLock keeps its data.
//
// chrome.storage.sync (follows the user's Chrome account to their other computers):
//   "lk:<site>:<id>" -> { site, id, lockedAt }   one key per locked chat, no titles
//   "auth"           -> { salt, hash, iterations, recoverySalt?, recoveryHash? }
// chrome.storage.local (this computer only):
//   "titles"         -> { "<site>:<id>": title }  so chat titles never leave the device
//   "credential"     -> Touch ID (WebAuthn) key, which is bound to this device anyway
//   "unlockedUntil", "authFail", "settings", "bridgeSeen"
//
// Loaded as a classic script by content scripts and imported by extension pages.
(() => {
  const PREFIX = "lk:";
  const keyOf = (site, id) => `${site}:${id}`;

  let migration;
  /** Moves data from the 0.1.0 layout (everything in local) to the sync layout. Idempotent. */
  function ready() {
    migration ??= (async () => {
      const old = await chrome.storage.local.get(["locked", "auth"]);
      if (old.locked) {
        const syncItems = {};
        const { titles = {} } = await chrome.storage.local.get("titles");
        for (const [k, l] of Object.entries(old.locked)) {
          syncItems[PREFIX + k] = { site: l.site, id: l.id, lockedAt: l.lockedAt ?? Date.now() };
          if (l.title) titles[k] = l.title;
        }
        await chrome.storage.sync.set(syncItems);
        await chrome.storage.local.set({ titles });
        await chrome.storage.local.remove("locked");
      }
      if (old.auth) {
        const { credential, ...rest } = old.auth;
        const { auth: synced } = await chrome.storage.sync.get("auth");
        if (!synced?.hash && rest.hash) await chrome.storage.sync.set({ auth: rest });
        if (credential) await chrome.storage.local.set({ credential });
        await chrome.storage.local.remove("auth");
      }
    })().catch((e) => {
      migration = undefined;
      throw e;
    });
    return migration;
  }

  async function getLocked() {
    await ready();
    const [all, { titles = {} }] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get("titles")]);
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PREFIX)) continue;
      const key = k.slice(PREFIX.length);
      out[key] = { ...v, title: titles[key] };
    }
    return out;
  }

  async function addLock({ site, id, title }) {
    await ready();
    const key = keyOf(site, id);
    await chrome.storage.sync.set({ [PREFIX + key]: { site, id, lockedAt: Date.now() } });
    if (title) await rememberTitles({ [key]: title });
    return { site, id, title, lockedAt: Date.now() };
  }

  async function removeLock(site, id) {
    await ready();
    const key = keyOf(site, id);
    await chrome.storage.sync.remove(PREFIX + key);
    const { titles = {} } = await chrome.storage.local.get("titles");
    delete titles[key];
    await chrome.storage.local.set({ titles });
  }

  /** Saves titles seen on this computer (e.g. for a lock made on another computer). */
  async function rememberTitles(map) {
    const { titles = {} } = await chrome.storage.local.get("titles");
    let changed = false;
    for (const [k, t] of Object.entries(map)) {
      const clean = String(t).replace(/\s+/g, " ").trim().slice(0, 200);
      if (clean && titles[k] !== clean) {
        titles[k] = clean;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ titles });
  }

  /** True if a storage change touches the lock list. */
  function locksChanged(changes, area) {
    return (area === "sync" && Object.keys(changes).some((k) => k.startsWith(PREFIX))) || (area === "local" && !!changes.titles);
  }

  async function getAuth() {
    await ready();
    const [{ auth }, { credential }] = await Promise.all([chrome.storage.sync.get("auth"), chrome.storage.local.get("credential")]);
    return auth || credential ? { ...(auth ?? {}), credential } : undefined;
  }

  async function saveAuth(patch) {
    const { auth = {} } = await chrome.storage.sync.get("auth");
    await chrome.storage.sync.set({ auth: { ...auth, ...patch } });
  }

  globalThis.AppLockStore = { PREFIX, keyOf, ready, getLocked, addLock, removeLock, rememberTitles, locksChanged, getAuth, saveAuth };
})();
