# AppLock

Lock and hide the AI chats you choose, behind Touch ID or a password — like Locked Notes on a Mac.

- **Browser extension** hides chosen **ChatGPT, Claude.ai and Gemini** chats from the sidebar and shows a lock screen if one is opened directly.
- **MCP server** encrypts local **Claude Code** and **Google Antigravity** sessions out of their history, and lets any MCP client (Claude Code, Antigravity, ChatGPT developer mode) hide chats for you.

Website with the full guide: https://harmantaj.github.io/applock-mcp/ (source in `website/`).

## Why two pieces

ChatGPT, Claude.ai and Gemini keep chats on their servers. An MCP server only gives a model tools; it can't change what a web page shows. So the extension does the hiding in the browser, and the MCP server handles local history plus a lock-only bridge to the extension.

## Install

```bash
npm install -g https://github.com/Harmantaj/applock-mcp/releases/download/v0.6.3/applock-mcp-0.6.3.tgz
applock-mcp setup                 # passphrase + optional Touch ID
applock-mcp install claude        # or: antigravity | chatgpt
```

Browser extension: download `applock-chrome.zip` or `applock-firefox.zip` from the [latest release](https://github.com/Harmantaj/applock-mcp/releases/latest). Chrome/Edge/Brave/Arc: unzip, `chrome://extensions` › Developer mode › **Load unpacked**. Firefox: `about:debugging` › This Firefox › Load Temporary Add-on (a permanent install needs the addons.mozilla.org listing). Build both with `node scripts/build-extensions.mjs`.

### On your phone

No app or extension can change the ChatGPT/Claude/Gemini phone apps, so AppLock covers phones in layers:

1. **Hide on your phone too** (setting, ChatGPT only): locking also archives the chat through ChatGPT's own API, so it leaves the chat list in the iPhone/Android/Mac apps; removing the lock unarchives it. Jobs sync, so a lock made anywhere is archived by whichever computer next has ChatGPT open.
2. **Per-chat lock in a phone browser**: Firefox for Android, or Orion (Kagi) on iPhone/iPad, with the Firefox build installed. A lock button appears on chat pages on touch screens.
3. **Face ID for the whole app**: iOS 18 *Require Face ID*; Android 15 *Private space*.
4. **Move to vault** (ChatGPT, Claude): saves an encrypted transcript in the vault on your computer, then deletes the chat at the provider, so it's gone from every app and device. Read it on your phone in the **AppLock Vault** web app (`/vault/<secret>/` on your tunnel address; add it to the Home Screen). Deletion only happens after the vault confirms the copy is stored.
5. **Phone connector** (below) to control your Mac from Claude on the phone.

### Claude everywhere (web, desktop, iPhone, Android) and ChatGPT on the web

Custom connectors added on claude.ai work in the Claude desktop and phone apps too; ChatGPT allows them only on chatgpt.com. On a Mac with [Tailscale](https://tailscale.com) installed and signed in:

```bash
applock-mcp install phone
```

This starts AppLock in the background (launchd), turns on Tailscale Funnel for AppLock only — it never reuses a port another program is serving, and never replaces someone else's Funnel route — verifies it from the internet, and copies the connector URL. Add it on claude.ai › Customize › Connectors › Add custom connector. From a phone, `unlock_vault` returns a one-time link to your Mac's unlock page, so the passphrase never passes through the AI. It can't hide chats inside the phone apps; it's a remote control for your Mac, which must be awake.

`applock-mcp remote url` · `applock-mcp remote rotate` · `applock-mcp uninstall phone`

## Tools

| Tool | Purpose | Needs unlock |
| --- | --- | --- |
| `applock_status` | Vault state, hidden count, extension connection | no |
| `list_sessions` | Visible Claude Code / Antigravity sessions | no |
| `hide_session` | Encrypt a session into the vault (`current` = when this session ends) | no |
| `list_browser_chats` | Web chats seen by the extension | no |
| `hide_browser_chat` | Lock a web chat (`current` = the open one; `everywhere` also archives it in ChatGPT) | no |
| `copy_to_vault` | Copy locked ChatGPT/Claude chats into the vault without deleting them (readable in the phone Vault) | no |
| `hide_on_phone` | Turn on ChatGPT archiving for locked chats so they leave the phone apps' lists | no |
| `unlock_vault` | Touch ID prompt, local passphrase page, or (remote) a one-time unlock link | — |
| `lock_vault` | Lock now | no |
| `list_hidden` | Everything in the vault | yes |
| `read_hidden` | Read a hidden transcript | yes |
| `restore_hidden` | Put a session back | yes |

## Security model

- Sessions are sealed to an X25519 public key (ephemeral ECDH + HKDF-SHA256 + AES-256-GCM), so hiding never needs the passphrase. The private key is wrapped with scrypt(passphrase); with Touch ID a copy lives in the macOS Keychain and a Swift helper releases it after `LAContext` authentication.
- The passphrase is never passed through the model: unlocking uses the Touch ID sheet or a one-time page on `127.0.0.1`.
- The bridge on `127.0.0.1:47521` accepts only browser-extension origins, pins the first extension that pairs, and is **lock-only** — nothing it sends can reveal a chat.
- The extension uses PBKDF2-SHA256 (600k) with lockout, and WebAuthn (platform authenticator) with local signature verification.
- Locks and the password hash live in `chrome.storage.sync`, so they follow your Chrome profile to your other computers; chat titles and the Touch ID key stay on each computer.
- Forgot the extension password? **Forgot password?** on the lock screen or popup resets it with Touch ID or the one-time recovery code (100 bits, stored hashed, rotated on use).
- Not protected: the provider's servers, the ChatGPT/Claude/Gemini phone apps (use iOS **Require Face ID** on the app instead), removing the extension, malware running as you. The Claude desktop app keeps its own session title list.

## Development

```bash
npm install
npm test                          # build + unit + MCP client tests (stdio and HTTP)
npx playwright install chromium
npm run test:e2e                  # extension on mocked ChatGPT/Claude/Gemini, bridge, website
```

`docs/REQUIREMENTS.md` has the research notes and requirements.

## License

MIT
