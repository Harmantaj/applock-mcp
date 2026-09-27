import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applockHome, helperPath } from "./paths.js";
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "touchid.swift");
// One Keychain entry per vault location, so test vaults never collide with the real one.
const account = () => createHash("sha256").update(applockHome()).digest("hex").slice(0, 16);
export function touchIdSupported() {
    return process.platform === "darwin";
}
/** Compiles the Swift helper on first use (needs Xcode Command Line Tools). */
export function ensureHelper() {
    if (!touchIdSupported())
        throw new Error("Touch ID is only available on macOS");
    const out = helperPath();
    if (existsSync(out))
        return out;
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    try {
        execFileSync("swiftc", ["-O", SOURCE, "-o", out], { stdio: "pipe" });
    }
    catch (e) {
        throw new Error(`Could not build the Touch ID helper (install Xcode Command Line Tools with "xcode-select --install"): ${e.stderr ?? e.message}`);
    }
    return out;
}
export function touchIdAvailable() {
    try {
        return execFileSync(ensureHelper(), ["available"], { stdio: "pipe" }).toString().trim();
    }
    catch {
        return undefined;
    }
}
export function storeKey(privateKey) {
    execFileSync(ensureHelper(), ["store", account()], { input: privateKey.toString("base64"), stdio: "pipe" });
}
export function deleteKey() {
    try {
        execFileSync(ensureHelper(), ["delete", account()], { stdio: "pipe" });
    }
    catch { }
}
/** Shows the system Touch ID sheet; resolves with the private key or rejects if cancelled. */
export function retrieveKey(reason) {
    return new Promise((resolve, reject) => {
        const child = spawn(ensureHelper(), ["retrieve", account(), reason], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => {
            if (code === 0 && out)
                resolve(Buffer.from(out, "base64"));
            else
                reject(new Error(err.trim() || `Touch ID helper exited with ${code}`));
        });
    });
}
