import { homedir } from "node:os";
import { join } from "node:path";
// Every location can be overridden by environment variables, which the tests
// use to run against throwaway directories.
export function applockHome() {
    return process.env.APPLOCK_HOME ?? join(homedir(), ".applock");
}
export function claudeProjectsDir() {
    return process.env.APPLOCK_CLAUDE_DIR ?? join(homedir(), ".claude", "projects");
}
export function antigravityRoots() {
    const env = process.env.APPLOCK_ANTIGRAVITY_DIRS;
    if (env)
        return env.split(":").filter(Boolean);
    return [
        join(homedir(), ".gemini", "antigravity"),
        join(homedir(), ".gemini", "antigravity-cli"),
    ];
}
export const configPath = () => join(applockHome(), "config.json");
export const vaultDir = () => join(applockHome(), "vault");
export const pendingPath = () => join(applockHome(), "pending.json");
export const bridgeQueuePath = () => join(applockHome(), "bridge-queue.json");
export const bridgeStatePath = () => join(applockHome(), "bridge-state.json");
export const helperPath = () => join(applockHome(), "bin", "applock-touchid");
export const BRIDGE_PORT = Number(process.env.APPLOCK_BRIDGE_PORT ?? 47521);
