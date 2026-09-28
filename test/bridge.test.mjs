import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { newer } = await import("../dist/bridge.js");
const { VERSION } = await import("../dist/version.js");

test("version comparison", () => {
  assert.equal(newer("0.5.2", "0.5.1"), true);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("0.5.1", "0.5.1"), false);
  assert.equal(newer("0.4.9", "0.5.0"), false);
});

test("a newer AppLock takes the bridge over from an older one", async () => {
  const fx = fixture();
  const port = Number(fx.env.APPLOCK_BRIDGE_PORT);
  let yielded = false;
  const old = createServer((req, res) => {
    if (req.url === "/applock/version") return res.end(JSON.stringify({ app: "applock-mcp", version: "0.0.1" }));
    if (req.url === "/applock/yield" && req.method === "POST") {
      yielded = true;
      res.end('{"yielded":true}');
      old.close();
      old.closeAllConnections();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => old.listen(port, "127.0.0.1", r));
  const proc = spawn(process.execPath, [CLI], { env: { ...process.env, ...fx.env }, stdio: ["pipe", "ignore", "ignore"] });
  try {
    let v;
    for (let i = 0; i < 40 && v !== VERSION; i++) {
      await new Promise((r) => setTimeout(r, 150));
      v = await fetch(`http://127.0.0.1:${port}/applock/version`).then((r) => r.json()).then((j) => j.version).catch(() => undefined);
    }
    assert.equal(yielded, true, "old owner was asked to yield");
    assert.equal(v, VERSION, "new process now owns the bridge");
    // A web page can't make it yield (browsers send Origin on POST).
    const r = await fetch(`http://127.0.0.1:${port}/applock/yield`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: '{"version":"99.0.0"}' });
    assert.equal(r.status, 403);
  } finally {
    proc.kill();
  }
});
