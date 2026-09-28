import type { BrowserContext } from "@playwright/test";

// Minimal look-alikes of each app's sidebar markup. Real requests to these hosts
// are intercepted, so the extension's content script runs on the real origins.
export const CHATGPT_CHATS = [
  { id: "67a1f0aa-1111-8000-9000-000000000001", title: "Therapy session notes" },
  { id: "67a1f0aa-2222-8000-9000-000000000002", title: "Weekly grocery list" },
  { id: "67a1f0aa-3333-8000-9000-000000000003", title: "Salary negotiation prep" },
];
export const CLAUDE_CHATS = [
  { id: "0b6b2c6e-aaaa-4bbb-8ccc-000000000001", title: "Divorce paperwork questions" },
  { id: "0b6b2c6e-aaaa-4bbb-8ccc-000000000002", title: "Python decorators explained" },
];
export const GEMINI_CHATS = [
  { id: "a1b2c3d4e5f60001", title: "Medical test results" },
  { id: "a1b2c3d4e5f60002", title: "Trip to Lisbon" },
];

const spa = (sidebar: string, titleFor: string) => `<!doctype html><html><head><title>App</title></head><body>
<nav id="sidebar">${sidebar}</nav>
<main id="main"><h1 id="heading"></h1><textarea id="composer" placeholder="Message"></textarea></main>
<script>
  const titles = ${titleFor};
  function render() {
    const id = location.pathname.split("/").filter(Boolean).pop();
    const t = titles[id] || "New chat";
    document.getElementById("heading").textContent = t;
    document.title = t;
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    history.pushState({}, "", a.getAttribute("href"));
    render();
  });
  render();
</script></body></html>`;

const titleMap = (chats: { id: string; title: string }[]) => JSON.stringify(Object.fromEntries(chats.map((c) => [c.id, c.title])));

export const chatgptHtml = spa(
  // Mirrors chatgpt.com (checked Sept 2026): ul > li > a[href=/c/<id>] with an options button inside.
  `<h2>Chats</h2><ul id="history">${CHATGPT_CHATS.map(
    (c, i) => `<li><a href="/c/${c.id}"><div><div class="truncate">${c.title}</div><button data-testid="history-item-${i}-options" data-conversation-options-trigger="${c.id}" aria-label="Open conversation options">⋯</button></div></a></li>`,
  ).join("")}</ul>`,
  titleMap(CHATGPT_CHATS),
);
export const claudeHtml = spa(
  // Mirrors claude.ai (checked Sept 2026): div rows holding the link and a "⋯" menu button.
  `<div class="recents">${CLAUDE_CHATS.map(
    (c) => `<div class="row"><div><div><a href="/chat/${c.id}"><span>${c.title}</span></a><button aria-label="More options for ${c.title}">⋯</button></div></div></div>`,
  ).join("")}</div>`,
  titleMap(CLAUDE_CHATS),
);
export const geminiHtml = spa(
  `<div class="conversations">${GEMINI_CHATS.map((c) => `<div class="conversation-item"><a href="/app/${c.id}"><div class="title">${c.title}</div></a></div>`).join("")}</div>`,
  titleMap(GEMINI_CHATS),
);

export async function mockSites(context: BrowserContext) {
  const html = (body: string) => ({ status: 200, contentType: "text/html", body });
  await context.route("https://chatgpt.com/**", (r) => r.fulfill(html(chatgptHtml)));
  await context.route("https://claude.ai/**", (r) => r.fulfill(html(claudeHtml)));
  await context.route("https://gemini.google.com/**", (r) => r.fulfill(html(geminiHtml)));
}
