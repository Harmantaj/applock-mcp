import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Copies the extension to a temp folder and points its MCP bridge at `port`.
 * A copy gets its own extension id and never talks to a real AppLock server
 * that may be running on this machine on the default port 47521.
 */
export function testExtension(port = 40000 + Math.floor(Math.random() * 20000)) {
  const dir = mkdtempSync(join(tmpdir(), "applock-ext-"));
  cpSync(resolve(process.cwd(), "extension"), dir, { recursive: true });
  for (const f of ["background.js", "manifest.json"]) {
    const p = join(dir, f);
    writeFileSync(p, readFileSync(p, "utf8").replaceAll("127.0.0.1:47521", `127.0.0.1:${port}`));
  }
  return { dir, port };
}
