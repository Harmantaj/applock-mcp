// Site adapters: how to find a chat id in a URL on each supported app.
// Loaded as a classic script by content scripts and imported by the service worker.
(() => {
  const SITES = [
    {
      key: "chatgpt",
      name: "ChatGPT",
      hosts: ["chatgpt.com", "chat.openai.com"],
      // /c/<id>, /g/<gpt>/c/<id>, /g/g-p-<project>/c/<id>
      chatId: (path) => path.match(/\/c\/([0-9a-zA-Z-]{8,})/)?.[1],
      linkSelector: 'a[href*="/c/"]',
      chatUrl: (id) => `https://chatgpt.com/c/${id}`,
    },
    {
      key: "claude",
      name: "Claude",
      hosts: ["claude.ai"],
      chatId: (path) => path.match(/\/chat\/([0-9a-fA-F-]{8,})/)?.[1],
      linkSelector: 'a[href*="/chat/"]',
      chatUrl: (id) => `https://claude.ai/chat/${id}`,
    },
    {
      key: "gemini",
      name: "Gemini",
      hosts: ["gemini.google.com"],
      // /app/<id> and /gem/<gem>/<id>
      chatId: (path) => path.match(/\/app\/([0-9a-zA-Z_-]{8,})/)?.[1] ?? path.match(/\/gem\/[^/]+\/([0-9a-zA-Z_-]{8,})/)?.[1],
      linkSelector: 'a[href*="/app/"], a[href*="/gem/"]',
      chatUrl: (id) => `https://gemini.google.com/app/${id}`,
    },
  ];

  function siteForHost(host) {
    return SITES.find((s) => s.hosts.includes(host));
  }

  /** Parses any URL into { site, id } if it points at a chat on a supported site. */
  function parseChatUrl(url) {
    try {
      const u = new URL(url);
      const site = siteForHost(u.hostname);
      const id = site?.chatId(u.pathname);
      return site && id ? { site: site.key, id } : undefined;
    } catch {
      return undefined;
    }
  }

  const keyOf = (site, id) => `${site}:${id}`;

  globalThis.AppLockSites = { SITES, siteForHost, parseChatUrl, keyOf };
})();
