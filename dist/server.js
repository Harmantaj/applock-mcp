import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { enqueue, extensionConnected, readState, waitForResult } from "./bridge.js";
import { findSession, listSessions } from "./sources.js";
import { touchIdSupported } from "./touchid.js";
import { createUnlockLink, currentKey, lock, unlockedUntil, unlockWithBrowser, unlockWithTouchId } from "./unlock.js";
import { findHidden, hiddenCount, hideSession, listHidden, loadConfig, loadPending, readHidden, recordBrowserLock, restoreHidden, savePending, } from "./vault.js";
export { VERSION } from "./version.js";
import { VERSION } from "./version.js";
const INSTRUCTIONS = `AppLock hides private chats. Hiding never needs unlocking. Listing, reading or restoring hidden chats needs unlock_vault, which shows a Touch ID prompt or opens a passphrase page on the user's computer; never ask the user to type their passphrase into chat. For ChatGPT/Claude/Gemini web chats, use hide_browser_chat (needs the AppLock browser extension). Do not repeat hidden chat contents unless the user asks.`;
const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });
function requireConfig() {
    const cfg = loadConfig();
    if (!cfg)
        throw new Error("AppLock is not set up yet. In a terminal, run:  applock-mcp setup  (install: npm install -g https://github.com/Harmantaj/applock-mcp/releases/download/v0.5.1/applock-mcp-0.5.1.tgz)");
    return cfg;
}
function requireKey() {
    const k = currentKey();
    if (!k)
        throw new Error("The vault is locked. Call unlock_vault first.");
    return k;
}
function describe(s) {
    const when = s.updatedAt.slice(0, 16).replace("T", " ");
    return `- ${s.title}${s.current ? "  (this session)" : ""}\n  id: ${s.id} · ${s.source} · ${when}${s.project ? ` · ${s.project}` : ""}`;
}
/** Hides pending sessions whose Claude Code process has finished. Safe to call often. */
export function sweepPending(opts = {}) {
    const cfg = loadConfig();
    if (!cfg)
        return [];
    // On shutdown the running session is finished, so it can be hidden too.
    const current = opts.includeCurrent ? undefined : process.env.CLAUDE_CODE_SESSION_ID;
    const done = [];
    const keep = [];
    for (const p of loadPending()) {
        const age = Date.now() - Date.parse(p.requestedAt);
        if (p.id !== current) {
            const s = findSession(p.id);
            if (s && s.id === p.id) {
                try {
                    hideSession(cfg, s);
                    done.push(s.id);
                }
                catch { }
            }
        }
        // Keep watching for a week in case the client writes a final fragment after exit.
        if (age < 7 * 86400_000)
            keep.push(p);
    }
    savePending(keep);
    return done;
}
export function createServer(opts = {}) {
    const server = new McpServer({ name: "applock", version: VERSION }, { instructions: INSTRUCTIONS });
    const safely = (fn) => async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return fail(e?.message ?? String(e));
        }
    };
    server.registerTool("applock_status", {
        title: "AppLock status",
        description: "Shows whether AppLock is set up, locked or unlocked, how many chats are hidden, and whether the browser extension is connected.",
        annotations: { readOnlyHint: true },
    }, safely(() => {
        const cfg = loadConfig();
        if (!cfg)
            return text("AppLock is not set up. Ask the user to run `applock-mcp setup` in a terminal.");
        const until = unlockedUntil();
        const st = readState();
        return text([
            `Vault: ${until ? `unlocked until ${until}` : "locked"}`,
            `Hidden items: ${hiddenCount()}`,
            `Touch ID: ${cfg.touchId ? "enabled" : touchIdSupported() ? "not enabled" : "not available on this OS"}`,
            `Auto-lock: ${cfg.autoLockMinutes} min`,
            `Browser extension: ${extensionConnected() ? `connected (${st.lockedCount ?? 0} web chats locked)` : "not connected"}`,
            ...(st.phone
                ? [
                    `Hide on phone (ChatGPT archive): ${st.phone.hiding ? "on" : "off"} · ${st.phone.archived}/${st.phone.chatgptLocked} locked ChatGPT chats archived${st.phone.pending ? ` · ${st.phone.pending} waiting for a ChatGPT tab` : ""}`,
                ]
                : []),
            `Pending hides (run when this session ends): ${loadPending().length}`,
        ].join("\n"));
    }));
    server.registerTool("list_sessions", {
        title: "List visible chat sessions",
        description: "Lists local Claude Code and Antigravity chat sessions that are currently visible (not hidden), newest first, so you can find the one to hide.",
        inputSchema: {
            source: z.enum(["all", "claude-code", "antigravity"]).default("all").describe("Which app's sessions to list"),
            query: z.string().optional().describe("Only sessions whose title contains this text (case-insensitive)"),
            limit: z.number().int().min(1).max(200).default(20),
        },
        annotations: { readOnlyHint: true },
    }, safely(({ source, query, limit }) => {
        let all = listSessions(source);
        if (query)
            all = all.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));
        if (!all.length)
            return text("No matching sessions found.");
        return text(`${all.length} session(s)${all.length > limit ? `, showing ${limit}` : ""}:\n` + all.slice(0, limit).map(describe).join("\n"));
    }));
    server.registerTool("hide_session", {
        title: "Hide a chat session",
        description: 'Encrypts a Claude Code or Antigravity session into the vault and removes it from the app\'s history. Works while locked. Use id "current" for the Claude Code session you are running in; it is hidden as soon as that session ends.',
        inputSchema: {
            id: z.string().min(1).describe('Session id from list_sessions (a unique prefix of 6+ characters works), or "current"'),
        },
        annotations: { destructiveHint: false, idempotentHint: false },
    }, safely(({ id }) => {
        const cfg = requireConfig();
        const current = process.env.CLAUDE_CODE_SESSION_ID;
        const targetId = id === "current" ? current : id;
        if (!targetId)
            return fail('No current session id is available here. Use list_sessions and pass a specific id.');
        if (targetId === current) {
            const pending = loadPending().filter((p) => p.id !== targetId);
            pending.push({ source: "claude-code", id: targetId, requestedAt: new Date().toISOString() });
            savePending(pending);
            return text(`This session (${targetId}) will be encrypted and hidden as soon as it ends. Its file is still being written, so it can't be moved yet.`);
        }
        const s = findSession(targetId);
        if (!s)
            return fail(`No visible session matches "${id}". It may already be hidden.`);
        const meta = hideSession(cfg, s);
        return text(`Hidden: "${meta.title}" (${meta.source}). ${meta.paths.length} path(s) encrypted into the vault.\nVault id: ${meta.vaultId}`);
    }));
    server.registerTool("list_browser_chats", {
        title: "List web chats seen by the extension",
        description: "Lists ChatGPT, Claude.ai and Gemini chats visible in the sidebar of the user's browser, as reported by the AppLock extension. Also says which chat is open right now.",
        inputSchema: { query: z.string().optional().describe("Filter by title text") },
        annotations: { readOnlyHint: true },
    }, safely(({ query }) => {
        if (!extensionConnected())
            return fail("The AppLock browser extension is not connected. Install it and open ChatGPT, Claude.ai or Gemini in the browser.");
        const st = readState();
        let chats = st.chats ?? [];
        if (query)
            chats = chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));
        const head = st.active ? `Open now: "${st.active.title}" on ${st.active.site} (id ${st.active.id})\n` : "No chat is open right now.\n";
        return text(head + (chats.length ? chats.slice(0, 50).map((c) => `- ${c.title}  [${c.site} · ${c.id}]`).join("\n") : "No chats reported."));
    }));
    server.registerTool("hide_browser_chat", {
        title: "Lock a ChatGPT / Claude / Gemini web chat",
        description: 'Tells the AppLock browser extension to lock a web chat: it disappears from the sidebar and shows a lock screen if opened, until unlocked with Touch ID or the password. Use chat_id "current" for the chat open in the browser.',
        inputSchema: {
            chat_id: z.string().min(1).describe('Chat id from list_browser_chats, or "current"'),
            site: z.enum(["chatgpt", "claude", "gemini"]).optional().describe("Needed only when chat_id isn't \"current\" and is ambiguous"),
            everywhere: z
                .boolean()
                .default(false)
                .describe("ChatGPT only: also archive it in the user's ChatGPT account so it leaves the chat list in the ChatGPT phone and desktop apps"),
        },
    }, safely(async ({ chat_id, site, everywhere }) => {
        const cfg = requireConfig();
        if (!extensionConnected())
            return fail("The AppLock browser extension is not connected. Install it and keep a ChatGPT, Claude.ai or Gemini tab open.");
        const st = readState();
        let target = chat_id === "current" ? st.active ?? undefined : st.chats?.find((c) => c.id === chat_id && (!site || c.site === site));
        if (chat_id === "current" && !target)
            return fail("No web chat is open in the browser right now.");
        if (!target && site)
            target = { site, id: chat_id, title: chat_id };
        if (!target)
            return fail(`Unknown chat "${chat_id}". Pass site as well, or pick one from list_browser_chats.`);
        const cmd = enqueue({ action: "lock", site: target.site, chatId: target.id, archive: everywhere });
        const r = await waitForResult(cmd.id);
        if (!r)
            return fail("The extension didn't respond within 45 seconds. Is Chrome running on the computer with AppLock enabled?");
        if (!r.ok)
            return fail(`The extension couldn't lock it: ${r.error}`);
        const chat = r.chat ?? target;
        recordBrowserLock(cfg, chat);
        const extra = everywhere && chat.site === "chatgpt"
            ? " It will also be archived in ChatGPT (gone from the phone app's list) as soon as ChatGPT is open in that browser."
            : "";
        return text(`Locked "${chat.title}" on ${chat.site}. It is hidden from the sidebar and needs Touch ID or the password to open.${extra}`);
    }));
    server.registerTool("hide_on_phone", {
        title: "Hide locked ChatGPT chats on the phone too",
        description: "Turns AppLock's 'Hide on your phone too' on or off. When on, locked ChatGPT chats are also archived in the user's ChatGPT account, so they disappear from the chat list in the ChatGPT iPhone/Android/desktop apps (still listed under ChatGPT's Archived chats). Removing a lock in the browser unarchives it. Claude and Gemini have no archive. Needs the AppLock browser extension.",
        inputSchema: {
            on: z.boolean().default(true),
            apply_to_locked: z.boolean().default(true).describe("Also archive ChatGPT chats that are already locked"),
        },
        annotations: { destructiveHint: false, idempotentHint: true },
    }, safely(async ({ on, apply_to_locked }) => {
        requireConfig();
        if (!extensionConnected())
            return fail("The AppLock browser extension is not connected. Chrome must be running on the computer with AppLock enabled.");
        const cmd = enqueue({ action: "phoneHiding", on, applyToLocked: apply_to_locked });
        const r = await waitForResult(cmd.id);
        if (!r)
            return fail("The extension didn't respond within 45 seconds. Reload AppLock in chrome://extensions if it was just updated.");
        if (!r.ok)
            return fail(`The extension refused: ${r.error}`);
        if (!on)
            return text("Hide on phone is off. New locks stay visible in the ChatGPT phone app; chats already archived stay archived until their lock is removed.");
        const n = r.detail?.queued ?? 0;
        return text(`Hide on phone is on.${n ? ` ${n} locked ChatGPT chat(s) queued for archiving;` : ""} Archiving happens as soon as chatgpt.com is open in that browser. Check progress with applock_status.`);
    }));
    server.registerTool("unlock_vault", {
        title: "Unlock the vault",
        description: opts.publicUrl
            ? "Unlocks hidden chats for a few minutes. Returns a one-time link (valid 5 minutes) the user opens on their phone or any browser to type their passphrase; it goes straight to their computer, never through the AI. After they say it's done, call applock_status to confirm. Method touchid shows Touch ID on the computer instead. Never ask for the passphrase in chat."
            : "Unlocks hidden chats for a few minutes. Shows the Touch ID prompt on the user's Mac, or opens a local passphrase page in their browser. The user authenticates on their own device; never ask for the passphrase in chat. Waits up to 2 minutes.",
        inputSchema: {
            method: z
                .enum(["auto", "touchid", "passphrase", "link"])
                .default("auto")
                .describe(opts.publicUrl
                ? "auto and link return a one-time unlock link; touchid prompts on the computer"
                : "auto uses Touch ID when enabled, otherwise the passphrase page"),
        },
        annotations: { readOnlyHint: true },
    }, safely(async ({ method }) => {
        const cfg = requireConfig();
        if (currentKey())
            return text(`Already unlocked until ${unlockedUntil()}.`);
        if (opts.publicUrl && (method === "auto" || method === "link")) {
            const url = createUnlockLink(opts.publicUrl);
            return text(`Ask the user to open this one-time link and enter their AppLock passphrase there (it expires in 5 minutes):\n${url}\nThe passphrase goes directly to their computer. Once they confirm, call applock_status.`);
        }
        if (method === "link")
            return fail("Unlock links need the HTTP server with --public-url.");
        const useTouch = method === "touchid" || (method === "auto" && cfg.touchId && touchIdSupported());
        if (useTouch) {
            try {
                await unlockWithTouchId(cfg);
                return text(`Unlocked with Touch ID until ${unlockedUntil()}.`);
            }
            catch (e) {
                if (method === "touchid")
                    return fail(`Touch ID failed: ${e.message}`);
            }
        }
        const r = await unlockWithBrowser(cfg);
        if (!r.ok)
            return fail(`Not unlocked (the passphrase page timed out or was closed). The page was ${r.url}`);
        return text(`Unlocked until ${unlockedUntil()}.`);
    }));
    server.registerTool("lock_vault", {
        title: "Lock the vault now",
        description: "Forgets the vault key immediately and re-locks web chats in the browser extension.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, safely(() => {
        lock();
        if (extensionConnected())
            enqueue({ action: "relock" });
        return text("Locked.");
    }));
    server.registerTool("list_hidden", {
        title: "List hidden chats",
        description: "Lists everything in the vault (titles, sources, dates). Requires the vault to be unlocked.",
        annotations: { readOnlyHint: true },
    }, safely(() => {
        requireConfig();
        const items = listHidden(requireKey());
        if (!items.length)
            return text("The vault is empty.");
        return text(items
            .map((m) => `- ${m.title}\n  ${m.source}${m.site ? `/${m.site}` : ""} · hidden ${m.hiddenAt.slice(0, 16).replace("T", " ")} · id: ${m.vaultId}`)
            .join("\n"));
    }));
    server.registerTool("read_hidden", {
        title: "Read a hidden chat",
        description: "Returns the transcript of a hidden local session without restoring it. Requires unlock. Note: the text becomes part of the current, visible conversation.",
        inputSchema: {
            id: z.string().min(1).describe("Vault id or original session id (prefix of 6+ chars works)"),
            max_chars: z.number().int().min(500).max(200000).default(20000),
        },
        annotations: { readOnlyHint: true },
    }, safely(({ id, max_chars }) => {
        requireConfig();
        const k = requireKey();
        return text(readHidden(k, findHidden(k, id), max_chars));
    }));
    server.registerTool("restore_hidden", {
        title: "Restore a hidden chat",
        description: "Decrypts a hidden session back to its original place so it shows up in the app again (or unlocks a web chat in the extension). Requires unlock.",
        inputSchema: { id: z.string().min(1).describe("Vault id or original session id") },
    }, safely(async ({ id }) => {
        requireConfig();
        const k = requireKey();
        const meta = findHidden(k, id);
        if (meta.source === "browser") {
            // By design the bridge can only lock. Revealing a web chat always needs
            // Touch ID or the password inside the browser itself.
            return fail(`"${meta.title}" is a web chat. Remove its lock from the AppLock extension popup in the browser (unlock there with Touch ID or the password).`);
        }
        savePending(loadPending().filter((p) => p.id !== meta.id));
        restoreHidden(k, meta);
        return text(`Restored "${meta.title}" (${meta.source}).`);
    }));
    return server;
}
