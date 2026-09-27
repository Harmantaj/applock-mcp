import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers.mjs";

const fx = fixture();
Object.assign(process.env, fx.env);
const crypto = await import("../dist/crypto.js");
const vault = await import("../dist/vault.js");
const sources = await import("../dist/sources.js");

test("sealed box round-trips and rejects the wrong key", () => {
  const a = crypto.newKeyPair();
  const b = crypto.newKeyPair();
  const box = crypto.seal(Buffer.from("secret chat"), a.publicKey);
  assert.equal(crypto.open(box, a.privateKey).toString(), "secret chat");
  assert.throws(() => crypto.open(box, b.privateKey));
  box[box.length - 1] ^= 1;
  assert.throws(() => crypto.open(box, a.privateKey), "tampering is detected");
});

test("titles come from custom title, then AI title, then first message", () => {
  const byId = Object.fromEntries(sources.listSessions("all").map((s) => [s.id, s]));
  assert.equal(byId["sess-aaaa-1111"].title, "Surprise party plan");
  assert.equal(byId["sess-bbbb-2222"].title, "Billing refactor");
  assert.equal(byId["sess-cccc-3333"].title, "What is 2+2?");
  assert.equal(byId["agconv-12345678"].title, "Medical results summary");
  assert.equal(byId["sess-aaaa-1111"].paths.length, 2, "includes the side folder");
});

test("hide needs no passphrase; restore brings back identical files", () => {
  const { cfg } = vault.createVault("correct horse", { autoLockMinutes: 5 });
  const original = readFileSync(join(fx.proj, "sess-aaaa-1111.jsonl"));
  const s = sources.findSession("sess-aaaa");
  const meta = vault.hideSession(cfg, s);
  assert.ok(!existsSync(join(fx.proj, "sess-aaaa-1111.jsonl")));
  assert.ok(!existsSync(join(fx.proj, "sess-aaaa-1111")));
  assert.equal(sources.findSession("sess-aaaa-1111"), undefined);
  assert.equal(vault.hiddenCount(), 1);

  // Nothing readable on disk.
  for (const f of readdirSync(join(fx.home, "vault"))) {
    assert.ok(!readFileSync(join(fx.home, "vault", f)).toString("latin1").includes("Surprise"));
  }

  assert.throws(() => vault.privateKeyFromPassphrase(cfg, "wrong"), /Wrong passphrase/);
  const key = vault.privateKeyFromPassphrase(cfg, "correct horse");
  const [listed] = vault.listHidden(key);
  assert.equal(listed.title, "Surprise party plan");
  assert.match(vault.readHidden(key, listed), /User: Help me plan a surprise party\n\nAssistant: Sure! Who is it for\?/);

  vault.restoreHidden(key, vault.findHidden(key, meta.vaultId));
  assert.deepEqual(readFileSync(join(fx.proj, "sess-aaaa-1111.jsonl")), original);
  assert.equal(readFileSync(join(fx.proj, "sess-aaaa-1111", "tool-result.txt"), "utf8"), "side data");
  assert.equal(vault.hiddenCount(), 0);
});

test("changing the passphrase keeps the same vault key", () => {
  const cfg = vault.loadConfig();
  const key = vault.privateKeyFromPassphrase(cfg, "correct horse");
  vault.changePassphrase(cfg, key, "new passphrase");
  const next = vault.loadConfig();
  assert.deepEqual(vault.privateKeyFromPassphrase(next, "new passphrase"), key);
  assert.throws(() => vault.privateKeyFromPassphrase(next, "correct horse"));
});

test("restoring merges a late fragment in time order, whichever is restored first", () => {
  const cfg = vault.loadConfig();
  const key = vault.privateKeyFromPassphrase(cfg, "new passphrase");
  const file = join(fx.proj, "sess-bbbb-2222.jsonl");
  const main = readFileSync(file, "utf8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const mainMeta = vault.hideSession(cfg, sources.findSession("sess-bbbb-2222"));
  writeFileSync(file, '{"type":"last-prompt"}\n');
  const fragMeta = vault.hideSession(cfg, sources.findSession("sess-bbbb-2222"));
  // Restore the main part first, then the (newer) fragment.
  vault.restoreHidden(key, mainMeta);
  vault.restoreHidden(key, fragMeta);
  assert.equal(readFileSync(file, "utf8"), main + '{"type":"last-prompt"}\n');
});
