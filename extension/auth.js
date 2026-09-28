// Password, recovery code and Touch ID (WebAuthn platform authenticator) for
// extension pages. See store.js for what is synced and what stays on this device.
import "./store.js";

const store = globalThis.AppLockStore;

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ITERATIONS = 600000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

function sameBytes(a, b) {
  a = new Uint8Array(a);
  b = new Uint8Array(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function getAuth() {
  return store.getAuth();
}

export async function getSettings() {
  return { autoLockMinutes: 5, bridge: true, ...((await chrome.storage.local.get("settings")).settings ?? {}) };
}

export async function setPassword(password) {
  if (!password || password.length < 4) throw new Error("Use at least 4 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  await store.saveAuth({ salt: b64(salt), hash: b64(hash), iterations: ITERATIONS });
}

/** Checks a secret against a stored hash with an escalating lockout after 5 misses. */
async function checkWithLockout(secret, salt, expected, iterations, wrongMessage) {
  const { authFail = { count: 0, until: 0 } } = await chrome.storage.local.get("authFail");
  if (Date.now() < authFail.until) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil((authFail.until - Date.now()) / 1000)}s.`);
  }
  const hash = await pbkdf2(secret, unb64(salt), iterations);
  if (sameBytes(hash, unb64(expected))) {
    await chrome.storage.local.remove("authFail");
    return true;
  }
  const count = authFail.count + 1;
  const until = count >= 5 ? Date.now() + 30000 * 2 ** (count - 5) : 0;
  await chrome.storage.local.set({ authFail: { count, until } });
  throw new Error(count >= 5 ? "Too many attempts. Locked for a while." : wrongMessage);
}

/** Throws a user-facing message on failure. */
export async function verifyPassword(password) {
  const auth = await getAuth();
  if (!auth?.hash) throw new Error("No password set yet.");
  return checkWithLockout(password, auth.salt, auth.hash, auth.iterations, "Wrong password.");
}

// ---- recovery code ---------------------------------------------------------------
// 20 characters from an unambiguous alphabet (100 bits), shown once, stored hashed.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function normalizeCode(code) {
  return String(code).toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Creates a new recovery code, replacing any previous one, and returns it for display. */
export async function createRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const raw = [...bytes].map((b) => ALPHABET[b % 32]).join("");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(raw, salt, 100000);
  await store.saveAuth({ recoverySalt: b64(salt), recoveryHash: b64(hash) });
  return raw.match(/.{5}/g).join("-");
}

export async function hasRecoveryCode() {
  return !!(await getAuth())?.recoveryHash;
}

/** Sets a new password after checking the recovery code; returns a fresh recovery code. */
export async function resetWithRecoveryCode(code, newPassword) {
  const auth = await getAuth();
  if (!auth?.recoveryHash) throw new Error("No recovery code was created for AppLock.");
  await checkWithLockout(normalizeCode(code), auth.recoverySalt, auth.recoveryHash, 100000, "That recovery code isn't right.");
  await setPassword(newPassword);
  return createRecoveryCode();
}

/** Sets a new password after Touch ID on this computer; returns a fresh recovery code. */
export async function resetWithTouchId(newPassword) {
  await verifyTouchId();
  await setPassword(newPassword);
  return createRecoveryCode();
}

// ---- Touch ID ------------------------------------------------------------------

// Firefox extension pages can hang on WebAuthn (bugzilla 1693562), so there the
// password is used instead.
const isFirefox = typeof browser !== "undefined" && !!browser.runtime?.getBrowserInfo;

export function touchIdPossible() {
  return !isFirefox && !!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
}

export async function touchIdAvailable() {
  try {
    return touchIdPossible() && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export async function registerTouchId() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: "AppLock" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "applock", displayName: "AppLock" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60000,
      attestation: "none",
    },
  });
  const pub = cred.response.getPublicKey?.();
  if (!pub) throw new Error("This browser didn't return a public key.");
  await chrome.storage.local.set({
    credential: { id: b64(cred.rawId), publicKey: b64(pub), alg: cred.response.getPublicKeyAlgorithm() },
  });
}

export async function removeTouchId() {
  await chrome.storage.local.remove("credential");
}

// WebAuthn ES256 signatures are DER; WebCrypto wants raw r||s.
function derToRaw(der) {
  der = new Uint8Array(der);
  let i = 2;
  const read = () => {
    i++; // 0x02
    const len = der[i++];
    let n = der.slice(i, i + len);
    i += len;
    while (n.length > 32 && n[0] === 0) n = n.slice(1);
    const out = new Uint8Array(32);
    out.set(n, 32 - n.length);
    return out;
  };
  const r = read();
  const s = read();
  return new Uint8Array([...r, ...s]);
}

/** Prompts Touch ID and verifies the signature against the stored public key. */
export async function verifyTouchId() {
  const auth = await getAuth();
  const c = auth?.credential;
  if (!c) throw new Error("Touch ID isn't set up.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: "public-key", id: unb64(c.id) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  const r = assertion.response;
  const client = JSON.parse(new TextDecoder().decode(r.clientDataJSON));
  const sentChallenge = b64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (client.type !== "webauthn.get" || client.challenge !== sentChallenge) throw new Error("Touch ID response didn't match.");
  const authData = new Uint8Array(r.authenticatorData);
  if (!(authData[32] & 0x04)) throw new Error("Touch ID didn't verify the user.");
  const signed = new Uint8Array([...authData, ...new Uint8Array(await crypto.subtle.digest("SHA-256", r.clientDataJSON))]);
  const ok =
    c.alg === -7
      ? await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          await crypto.subtle.importKey("spki", unb64(c.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
          derToRaw(r.signature),
          signed,
        )
      : await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          await crypto.subtle.importKey("spki", unb64(c.publicKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
          r.signature,
          signed,
        );
  if (!ok) throw new Error("Touch ID signature check failed.");
  return true;
}

/** Reveals locked chats for the configured number of minutes. */
export async function startUnlockedSession() {
  const { autoLockMinutes } = await getSettings();
  await chrome.storage.local.set({ unlockedUntil: Date.now() + autoLockMinutes * 60000 });
}

export async function relockNow() {
  await chrome.storage.local.set({ unlockedUntil: 0 });
}
