# AppLock

Lock and hide the AI chats you choose, behind Touch ID or a password — like Locked Notes on a Mac.

- **Browser extension** hides chosen **ChatGPT, Claude.ai and Gemini** chats from the sidebar and shows a lock screen if one is opened directly.
- **MCP server** encrypts local **Claude Code** and **Google Antigravity** sessions out of their history, and lets any MCP client (Claude Code, Antigravity, ChatGPT developer mode) hide chats for you.

Website with the full guide: https://harmantaj.github.io/applock-mcp/ (source in `website/`).

## Why two pieces

ChatGPT, Claude.ai and Gemini keep chats on their servers. An MCP server only gives a model tools; it can't change what a web page shows. So the extension does the hiding in the browser, and the MCP server handles local history plus a lock-only bridge to the extension.

## Install

```bash
npm install -g github:Harmantaj/applock-mcp
applock-mcp setup                 # passphrase + optional Touch ID
applock-mcp install claude        # or: antigravity | chatgpt
```

Browser extension: download `applock-extension.zip` from the website (or use the `extension/` folder), open `chrome://extensions`, enable Developer mode, **Load unpacked**.

### ChatGPT

ChatGPT only connects to remote MCP servers:

```bash
applock-mcp serve --http --port 8787
cloudflared tunnel --url http://localhost:8787
```

Then in ChatGPT: Settings › Apps & Connectors › Advanced › Developer mode › create a connector with `https://<tunnel>/mcp/<secret>` (the secret path is printed by `applock-mcp install chatgpt`), no authentication.

## Tools

| Tool | Purpose | Needs unlock |
| --- | --- | --- |
| `applock_status` | Vault state, hidden count, extension connection | no |
| `list_sessions` | Visible Claude Code / Antigravity sessions | no |
| `hide_session` | Encrypt a session into the vault (`current` = when this session ends) | no |
| `list_browser_chats` | Web chats seen by the extension | no |
| `hide_browser_chat` | Lock a web chat (`current` = the open one) | no |
| `unlock_vault` | Touch ID prompt or local passphrase page | — |
| `lock_vault` | Lock now | no |
| `list_hidden` | Everything in the vault | yes |
| `read_hidden` | Read a hidden transcript | yes |
| `restore_hidden` | Put a session back | yes |

## Security model

- Sessions are sealed to an X25519 public key (ephemeral ECDH + HKDF-SHA256 + AES-256-GCM), so hiding never needs the passphrase. The private key is wrapped with scrypt(passphrase); with Touch ID a copy lives in the macOS Keychain and a Swift helper releases it after `LAContext` authentication.
- The passphrase is never passed through the model: unlocking uses the Touch ID sheet or a one-time page on `127.0.0.1`.
- The bridge on `127.0.0.1:47521` accepts only browser-extension origins, pins the first extension that pairs, and is **lock-only** — nothing it sends can reveal a chat.
- The extension uses PBKDF2-SHA256 (600k) with lockout, and WebAuthn (platform authenticator) with local signature verification.
- Not protected: the provider's servers, your account on other devices, malware running as you. The Claude desktop app keeps its own session title list.

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
