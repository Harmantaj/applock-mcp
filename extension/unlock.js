import "./selfupdate.js";
import { getAuth, startUnlockedSession, verifyPassword, verifyTouchId } from "./auth.js";

// ?update=1: loaded invisibly by the content script just for selfupdate.js.
if (new URLSearchParams(location.search).has("update")) throw new Error("update check only");

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const embedded = params.has("embedded");

async function done() {
  await startUnlockedSession();
  if (!embedded) window.close();
}

function showError(e) {
  $("err").textContent = e?.name === "NotAllowedError" ? "Touch ID was cancelled." : e?.message ?? String(e);
}

const auth = await getAuth();
if (auth?.credential) {
  $("touch").hidden = false;
  $("or").hidden = false;
  $("submit").classList.remove("primary");
} else {
  $("submit").classList.add("primary");
  $("pw").autofocus = true;
  $("pw").focus();
}
if (!auth?.hash) {
  $("err").textContent = "Set a password in AppLock settings first.";
}

$("touch").addEventListener("click", async () => {
  $("err").textContent = "";
  try {
    await verifyTouchId();
    await done();
  } catch (e) {
    showError(e);
  }
});

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("submit").disabled = true;
  $("err").textContent = "";
  try {
    await verifyPassword($("pw").value);
    $("pw").value = "";
    await done();
  } catch (e) {
    showError(e);
    $("pw").select();
  } finally {
    $("submit").disabled = false;
  }
});

$("forgot").addEventListener("click", () => chrome.runtime.sendMessage({ type: "openRecovery" }));
$("back").hidden = !embedded;
$("back").addEventListener("click", () => chrome.runtime.sendMessage({ type: "goHome", site: params.get("site") }));
