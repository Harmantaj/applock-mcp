import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const phone = await import("../dist/phone.js");
const listen = (handler) =>
  new Promise((r) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => r(s));
  });

test("never picks a port another program is using; reuses AppLock's own", async () => {
  const other = await listen((_q, res) => res.end("hello from another app"));
  const busy = other.address().port;
  const picked = await phone.chooseLocalPort(busy);
  assert.notEqual(picked, busy, "a port used by another program is skipped");
  const mine = await listen((_q, res) => res.end("applock-mcp ok 1.0.0"));
  assert.equal(await phone.chooseLocalPort(mine.address().port), mine.address().port, "AppLock's own port is reused");
  other.close();
  mine.close();
});

test("Funnel port choice leaves other people's routes alone", () => {
  const host = "mac.tail1.ts.net";
  assert.equal(phone.pickFunnelPort({}, host, 8797), 443);
  const withDashboard = { TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } };
  assert.equal(phone.pickFunnelPort(withDashboard, host, 8797), 8443, "443 already serves something else");
  const ours = { TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8797" } } } } };
  assert.equal(phone.pickFunnelPort(ours, host, 8797), 443, "reuses our own route");
  const full = { TCP: { 443: {}, 8443: {}, 10000: {} }, Web: {} };
  assert.equal(phone.pickFunnelPort(full, host, 8797), undefined);
  assert.equal(phone.funnelTarget(ours, host, 443), "http://127.0.0.1:8797");
});

test("reads Tailscale sign-in state and host name", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-"));
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/bin/sh\necho '{"BackendState":"Running","Self":{"DNSName":"my-mac.tail9.ts.net."}}'\n`);
  chmodSync(bin, 0o755);
  assert.deepEqual(phone.tailscaleStatus(bin), { running: true, host: "my-mac.tail9.ts.net" });
  writeFileSync(bin, `#!/bin/sh\necho '{"BackendState":"NeedsLogin","Self":{}}'\n`);
  assert.deepEqual(phone.tailscaleStatus(bin), { running: false, host: undefined });
});
