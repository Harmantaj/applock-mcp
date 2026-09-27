// Password + Touch ID (WebAuthn platform authenticator) for extension pages.
// Everything stays in chrome.storage.local on this browser profile.

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

export async function getAuth() {
  return (await chrome.storage.local.get("auth")).auth;
}

export async function getSettings() {
  return { autoLockMinutes: 5, bridge: true, ...((await chrome.storage.local.get("settings")).settings ?? {}) };
}

export async function setPassword(password) {
  if (!password || password.length < 4) throw new Error("Use at least 4 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  const prev = (await getAuth()) ?? {};
  await chrome.storage.local.set({ auth: { ...prev, salt: b64(salt), hash: b64(hash), iterations: ITERATIONS } });
}

/** Throws a user-facing message on failure; applies an escalating lockout after 5 misses. */
export async function verifyPassword(password) {
  const auth = await getAuth();
  if (!auth?.hash) throw new Error("No password set yet.");
  const { authFail = { count: 0, until: 0 } } = await chrome.storage.local.get("authFail");
  if (Date.now() < authFail.until) {
    throw new Error(`Too many attempts. Try again in ${Math.ceil((authFail.until - Date.now()) / 1000)}s.`);
  }
  const hash = await pbkdf2(password, unb64(auth.salt), auth.iterations);
  if (sameBytes(hash, unb64(auth.hash))) {
    await chrome.storage.local.remove("authFail");
    return true;
  }
  const count = authFail.count + 1;
  const until = count >= 5 ? Date.now() + 30000 * 2 ** (count - 5) : 0;
  await chrome.storage.local.set({ authFail: { count, until } });
  throw new Error(count >= 5 ? "Too many attempts. Locked for a while." : "Wrong password.");
}

// ---- Touch ID ------------------------------------------------------------------

export function touchIdPossible() {
  return !!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
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
  const auth = (await getAuth()) ?? {};
  await chrome.storage.local.set({
    auth: { ...auth, credential: { id: b64(cred.rawId), publicKey: b64(pub), alg: cred.response.getPublicKeyAlgorithm() } },
  });
}

export async function removeTouchId() {
  const auth = (await getAuth()) ?? {};
  delete auth.credential;
  await chrome.storage.local.set({ auth });
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
