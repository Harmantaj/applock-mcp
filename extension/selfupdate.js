// Chrome runs an unpacked extension's background and content scripts from the copy
// it loaded, but serves its pages straight from disk. So every page checks whether
// the files on disk are newer than what is running and, if so, reloads the whole
// extension once (for people who update by unzipping over the old folder).
const running = chrome.runtime.getManifest().version;
fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })
  .then((r) => r.json())
  .then((m) => {
    if (m.version && m.version !== running) chrome.runtime.reload();
  })
  .catch(() => {});
