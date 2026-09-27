# AppLock — technical requirements

## Goal
Lock or hide chosen AI chats so they are invisible to anyone else using the same
computer or browser, unlocked with Touch ID or a passphrase — like Locked Notes
in Apple Notes.

## What is and is not possible (research findings, Sept 2026)
- **ChatGPT, Claude.ai and Gemini web chats live on the vendor's servers.** No
  MCP server can remove them from the vendor's sidebar; an MCP only gives a model
  tools. Hiding them in the sidebar requires a **browser extension** that
  rewrites the page locally.
- **Claude Code** stores each session as `~/.claude/projects/<project>/<id>.jsonl`
  (plus an optional `<id>/` folder). Titles come from `custom-title` /
  `ai-title` records or the first user message. The running session's id is in
  `CLAUDE_CODE_SESSION_ID`.
- **Antigravity** stores conversations as `~/.gemini/antigravity/conversations/<id>.pb`
  with `annotations/<id>.pbtxt` and `brain/<id>/`; the CLI uses
  `~/.gemini/antigravity-cli/`. MCP config: `~/.gemini/config/mcp_config.json`.
- **ChatGPT** only connects to *remote* MCP servers (Streamable HTTP or SSE,
  OAuth or no auth) in Developer Mode on paid plans. A local server must be
  exposed through a tunnel (e.g. `cloudflared tunnel --url`).
- Chrome extension pages may use WebAuthn (Touch ID) with an
  `chrome-extension://<id>` relying party.

## Components
1. **`applock-mcp`** (Node ≥ 20, TypeScript, `@modelcontextprotocol/sdk`)
   - stdio transport (Claude Code, Antigravity) and Streamable HTTP (ChatGPT).
   - Encrypted vault in `~/.applock`: X25519 sealed boxes, so *hiding never
     needs unlocking*; reading or restoring needs the private key.
   - Private key wrapped by scrypt(passphrase); optional copy in the macOS
     Keychain released only after a Touch ID check (Swift helper).
   - Unlock happens out-of-band (Touch ID dialog or a localhost passphrase
     page) — the passphrase never passes through the model.
   - Local bridge on `127.0.0.1:47521` that the extension polls, so a model can
     say "lock the chat I have open" in any client.
2. **Browser extension** (Chrome MV3; Chrome, Edge, Brave, Arc)
   - Hides locked chats in the ChatGPT / Claude / Gemini sidebars.
   - Full-page lock screen if a locked chat is opened directly.
   - Password (PBKDF2-SHA256, 600k) + optional Touch ID (WebAuthn platform
     authenticator); auto-relock timer; context menu and shortcuts.
3. **Website** — static docs site on Vercel.

## Threat model
Protects against people who use your unlocked Mac or browser profile and browse
your chat history. It does **not** protect web chats from the vendor, from
someone logged into your account on another device, or from malware running as
you. Local Claude Code / Antigravity sessions are genuinely encrypted at rest.

## Test plan
- Unit tests (`node --test`): crypto round-trip, hide/restore, title parsing.
- MCP client tests over stdio and HTTP using the SDK client.
- Real Claude Code run with the server registered.
- Playwright: extension against mocked chatgpt.com / claude.ai / gemini pages
  (network routed to fixtures), and the website.
