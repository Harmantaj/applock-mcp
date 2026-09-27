# AppLock

Lock and hide the AI chats you choose, behind Touch ID or a password — like Locked Notes on a Mac.

- **Browser extension** hides chosen **ChatGPT, Claude.ai and Gemini** chats from the sidebar and shows a lock screen if one is opened directly.
- **MCP server** encrypts local **Claude Code** and **Google Antigravity** sessions out of their history, and lets any MCP client (Claude Code, Antigravity, ChatGPT developer mode) hide chats for you.

Website with the full guide: https://harmantaj.github.io/applock-mcp/ (source in `website/`).

## Why two pieces

ChatGPT, Claude.ai and Gemini keep chats on their servers. An MCP server only gives a model tools; it can't change what a web page shows. So the extension does the hiding in the browser, and the MCP server handles local history plus a lock-only bridge to the extension.

## Install

```bash
npm install -g https://github.com/Harmantaj/applock-mcp/releases/download/v0.3.1/applock-mcp-0.3.1.tgz
applock-mcp setup                 # passphrase + optional Touch ID
applock-mcp install claude        # or: antigravity | chatgpt
```

Browser extension: download `applock-extension.zip` from the website (or use the `extension/` folder), open `chrome://extensions`, enable Developer mode, **Load unpacked**.

### Claude on your phone (and ChatGPT on the web)

Claude's iPhone/Android apps can use custom connectors added on claude.ai; ChatGPT allows them only on the web. Give your Mac a permanent HTTPS address with Tailscale Funnel, then keep AppLock running in the background:

```bash
brew install --cask tailscale-app          # open it and sign in
tailscale funnel --bg 8787                 # approve Funnel the first time
applock-mcp install remote --public-url https://<your-mac>.<tailnet>.ts.net
```

Add the printed connector URL on claude.ai › Settings › Connectors › Add custom connector (or in ChatGPT web: Settings › Apps & Connectors › Advanced › Developer mode, no authentication). From a phone, `unlock_vault` returns a one-time link to your Mac's unlock page, so the passphrase never passes through the AI. It still can't hide chats inside the phone apps; it's a remote control for your Mac, which must be awake.

## Tools

| Tool | Purpose | Needs unlock |
| --- | --- | --- |
| `applock_status` | Vault state, hidden count, extension connection | no |
| `list_sessions` | Visible Claude Code / Antigravity sessions | no |
| `hide_session` | Encrypt a session into the vault (`current` = when this session ends) | no |
| `list_browser_chats` | Web chats seen by the extension | no |
| `hide_browser_chat` | Lock a web chat (`current` = the open one) | no |
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
