// Builds store-ready packages from extension/:
//   dist-ext/applock-chrome.zip   Chrome, Edge, Brave, Arc (Chrome Web Store)
//   dist-ext/applock-firefox.zip  Firefox desktop + Android, Orion on iPhone/iPad (addons.mozilla.org)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const out = join(root, "dist-ext");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Fail fast on syntax errors in any extension script.
for (const f of ["background.js", "content.js", "sites.js", "store.js", "auth.js", "popup.js", "options.js", "unlock.js", "selfupdate.js"]) {
  execFileSync(process.execPath, ["--check", join(root, "extension", f)], { stdio: "inherit" });
}

function build(name, transform) {
  const dir = join(out, name);
  cpSync(join(root, "extension"), dir, { recursive: true, filter: (p) => !p.split("/").pop().startsWith(".") });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(transform(manifest), null, 2) + "\n");
  execFileSync("zip", ["-q", "-r", join(out, `applock-${name}.zip`), "."], { cwd: dir });
  return dir;
}

build("chrome", (m) => m);
build("firefox", (m) => {
  // Firefox MV3 runs background scripts as an event page, not a service worker.
  m.background = { scripts: ["background.js"], type: "module" };
  m.browser_specific_settings = {
    gecko: {
      id: "applock@harmantaj.github.io",
      strict_min_version: "142.0",
      // AppLock sends nothing anywhere; required for new Firefox extensions.
      data_collection_permissions: { required: ["none"] },
    },
    gecko_android: { strict_min_version: "142.0" },
  };
  return m;
});
console.log("Built dist-ext/applock-chrome.zip and dist-ext/applock-firefox.zip");
