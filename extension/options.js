import "./selfupdate.js";
import "./store.js";
import {
  createRecoveryCode,
  getAuth,
  getSettings,
  hasRecoveryCode,
  registerTouchId,
  removeTouchId,
  resetWithRecoveryCode,
  resetWithTouchId,
  setPassword,
  touchIdAvailable,
  verifyPassword,
  verifyTouchId,
} from "./auth.js";

const $ = (id) => document.getElementById(id);
const touchErr = (e) => (e?.name === "NotAllowedError" ? "Touch ID was cancelled." : e?.message ?? String(e));

function showCode(code) {
  $("codeText").textContent = code;
  $("codeCard").hidden = false;
  $("codeCard").scrollIntoView({ block: "center" });
}

async function render() {
  const auth = await getAuth();
  const has = !!auth?.hash;
  $("curField").hidden = !has;
  $("pwHeading").textContent = has ? "Password" : "1 · Choose a password";
  $("pwSave").textContent = has ? "Change password" : "Save password";
  const canTouch = await touchIdAvailable();
  $("touchOn").hidden = !!auth?.credential;
  $("touchOff").hidden = !auth?.credential;
  $("touchOn").disabled = !has || !canTouch;
  $("touchInfo").textContent = !canTouch
    ? "Touch ID isn't available in this browser or on this device. The password still works."
    : auth?.credential
      ? "Touch ID is on for this computer."
      : has
        ? "Unlock with your fingerprint instead of typing the password."
        : "Set a password first.";

  const hasCode = await hasRecoveryCode();
  $("recoveryCard").hidden = !has;
  $("recoveryInfo").textContent = hasCode
    ? "You have a recovery code. Creating a new one replaces it."
    : "You don't have a recovery code yet. Create one so a forgotten password isn't a dead end.";
  $("newCodeTouch").hidden = !auth?.credential;

  $("recover").hidden = location.hash !== "#recover" || !has;
  $("resetTouch").hidden = !auth?.credential;
  $("rcode").closest(".field").hidden = !hasCode;
  $("resetCode").hidden = !hasCode;
  $("noWay").hidden = !!auth?.credential || hasCode;

  const prefs = await globalThis.AppLockStore.getPrefs();
  $("archiveOnLock").checked = prefs.archiveOnLock;
  $("phoneCard").hidden = !has;

  const s = await getSettings();
  $("mins").value = s.autoLockMinutes;
  $("bridge").checked = s.bridge;
  $("lockButton").value = s.lockButton ?? "auto";
}

async function saveSettings(patch) {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: { ...s, ...patch } });
}

$("pwForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("pwErr").textContent = "";
  $("pwOk").textContent = "";
  try {
    const first = !(await getAuth())?.hash;
    if (!first) await verifyPassword($("cur").value);
    if ($("pw1").value !== $("pw2").value) throw new Error("The passwords don't match.");
    await setPassword($("pw1").value);
    for (const id of ["cur", "pw1", "pw2"]) $(id).value = "";
    $("pwOk").textContent = "Saved.";
    if (first) showCode(await createRecoveryCode());
    render();
  } catch (e) {
    $("pwErr").textContent = e.message;
  }
});

$("copyCode").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("codeText").textContent);
  $("copyCode").textContent = "Copied";
});
$("savedCode").addEventListener("click", () => {
  $("codeText").textContent = "";
  $("codeCard").hidden = true;
  $("copyCode").textContent = "Copy code";
});

$("newCodeForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("codeErr").textContent = "";
  try {
    await verifyPassword($("codePw").value);
    $("codePw").value = "";
    showCode(await createRecoveryCode());
    render();
  } catch (e) {
    $("codeErr").textContent = e.message;
  }
});
$("newCodeTouch").addEventListener("click", async () => {
  $("codeErr").textContent = "";
  try {
    await verifyTouchId();
    showCode(await createRecoveryCode());
    render();
  } catch (e) {
    $("codeErr").textContent = touchErr(e);
  }
});

function newPassword() {
  if ($("rp1").value.length < 4) throw new Error("Use at least 4 characters.");
  if ($("rp1").value !== $("rp2").value) throw new Error("The passwords don't match.");
  return $("rp1").value;
}

async function afterReset(code) {
  for (const id of ["rp1", "rp2", "rcode"]) $(id).value = "";
  history.replaceState(null, "", location.pathname);
  showCode(code);
  $("pwOk").textContent = "Password reset.";
  render();
}

$("resetTouch").addEventListener("click", async () => {
  $("resetErr").textContent = "";
  try {
    await afterReset(await resetWithTouchId(newPassword()));
  } catch (e) {
    $("resetErr").textContent = touchErr(e);
  }
});
$("resetForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("resetErr").textContent = "";
  try {
    await afterReset(await resetWithRecoveryCode($("rcode").value, newPassword()));
  } catch (e) {
    $("resetErr").textContent = e.message;
  }
});

$("touchOn").addEventListener("click", async () => {
  $("touchErr").textContent = "";
  try {
    await registerTouchId();
    $("touchOk").textContent = "Touch ID is on.";
    render();
  } catch (e) {
    $("touchErr").textContent = touchErr(e);
  }
});
$("touchOff").addEventListener("click", async () => {
  await removeTouchId();
  $("touchOk").textContent = "";
  render();
});
$("mins").addEventListener("change", () => {
  const n = Math.min(120, Math.max(1, Number($("mins").value) || 5));
  $("mins").value = n;
  saveSettings({ autoLockMinutes: n });
});
$("bridge").addEventListener("change", () => saveSettings({ bridge: $("bridge").checked }));
$("lockButton").addEventListener("change", () => saveSettings({ lockButton: $("lockButton").value }));
$("archiveOnLock").addEventListener("change", () => globalThis.AppLockStore.setPrefs({ archiveOnLock: $("archiveOnLock").checked }));
$("archiveExisting").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "archiveExisting" });
  $("archiveOk").textContent = r?.ok
    ? r.value
      ? `Queued ${r.value}. They’re archived next time ChatGPT is open in this browser.`
      : "Nothing to archive."
    : r?.error ?? "Couldn’t queue that.";
});
window.addEventListener("hashchange", render);

render();
