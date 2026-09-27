// Renders the extension/website icon from SVG to PNG with Playwright.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

export const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs>
<rect width="128" height="128" rx="28" fill="url(#g)"/>
<path d="M44 58V44a20 20 0 0 1 40 0v14" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/>
<rect x="32" y="56" width="64" height="48" rx="12" fill="#fff"/>
<path d="M50 78h28M50 88h18" stroke="#6d28d9" stroke-width="6" stroke-linecap="round" opacity=".85"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128, 180, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${SVG.replace("<svg ", `<svg width="${size}" height="${size}" `)}`);
  const png = await page.screenshot({ omitBackground: true });
  if (size <= 128) writeFileSync(`extension/icons/${size}.png`, png);
  if (size >= 128) writeFileSync(`website/icon-${size}.png`, png);
}
writeFileSync("website/favicon.svg", SVG);
await browser.close();
