import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, } from "node:crypto";
// Sealed-box format (all binary):
//   "ALK1" | ephemeral X25519 public key (32) | iv (12) | GCM tag (16) | ciphertext
// Anyone holding the vault public key can seal; only the private key can open.
// This lets the server hide sessions while the vault is locked.
const MAGIC = Buffer.from("ALK1");
const INFO = Buffer.from("applock-v1");
export function newKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    return {
        publicKey: publicKey.export({ format: "jwk" }).x,
        privateKey: privateKey.export({ format: "der", type: "pkcs8" }),
    };
}
function publicFromRaw(x) {
    return createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
}
function privateFromDer(der) {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}
function deriveKey(shared, ephX, recipientX) {
    return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephX, recipientX]), INFO, 32));
}
export function seal(plaintext, recipientPublic) {
    const eph = generateKeyPairSync("x25519");
    const ephX = Buffer.from(eph.publicKey.export({ format: "jwk" }).x, "base64url");
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(recipientPublic) });
    const key = deriveKey(shared, ephX, Buffer.from(recipientPublic, "base64url"));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, ephX, iv, cipher.getAuthTag(), ct]);
}
export function open(box, privateDer) {
    if (!box.subarray(0, 4).equals(MAGIC))
        throw new Error("Not an AppLock sealed file");
    const ephX = box.subarray(4, 36);
    const iv = box.subarray(36, 48);
    const tag = box.subarray(48, 64);
    const ct = box.subarray(64);
    const priv = privateFromDer(privateDer);
    const recipientX = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x, "base64url");
    const shared = diffieHellman({ privateKey: priv, publicKey: publicFromRaw(ephX.toString("base64url")) });
    const key = deriveKey(shared, ephX, recipientX);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}
export function newKdfParams() {
    return { salt: randomBytes(16).toString("base64"), N: 2 ** 17, r: 8, p: 1 };
}
export function passphraseKey(passphrase, kdf) {
    return scryptSync(passphrase.normalize("NFKC"), Buffer.from(kdf.salt, "base64"), 32, {
        N: kdf.N,
        r: kdf.r,
        p: kdf.p,
        maxmem: 256 * 1024 * 1024,
    });
}
// Symmetric wrap for the private key: iv (12) | tag (16) | ciphertext, base64.
export function wrap(data, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}
export function unwrap(wrapped, key) {
    const buf = Buffer.from(wrapped, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}
