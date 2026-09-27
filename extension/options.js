import { getAuth, getSettings, registerTouchId, removeTouchId, setPassword, touchIdAvailable, verifyPassword } from "./auth.js";

const $ = (id) => document.getElementById(id);

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
      ? "Touch ID is on."
      : has
        ? "Unlock with your fingerprint instead of typing the password."
        : "Set a password first.";
  const s = await getSettings();
  $("mins").value = s.autoLockMinutes;
  $("bridge").checked = s.bridge;
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
    if (await getAuth().then((a) => a?.hash)) await verifyPassword($("cur").value);
    if ($("pw1").value !== $("pw2").value) throw new Error("The passwords don't match.");
    await setPassword($("pw1").value);
    for (const id of ["cur", "pw1", "pw2"]) $(id).value = "";
    $("pwOk").textContent = "Saved.";
    render();
  } catch (e) {
    $("pwErr").textContent = e.message;
  }
});

$("touchOn").addEventListener("click", async () => {
  $("touchErr").textContent = "";
  try {
    await registerTouchId();
    $("touchOk").textContent = "Touch ID is on.";
    render();
  } catch (e) {
    $("touchErr").textContent = e.name === "NotAllowedError" ? "Touch ID was cancelled." : e.message;
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

render();
