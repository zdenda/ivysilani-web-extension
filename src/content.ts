// Content script: runs in every page and adds a "Hello World" badge to the
// bottom-left corner.
//
// `webextension-polyfill` gives us the promise-based `browser.*` API in both
// Firefox (where it is native) and Chrome (where it wraps `chrome.*`).

import browser from "webextension-polyfill";

const BADGE_ID = "hello-world-extension-badge";

function createBadge(): HTMLDivElement {
  const { name, version } = browser.runtime.getManifest();

  const badge = document.createElement("div");
  badge.id = BADGE_ID;
  badge.textContent = "Hello World";
  badge.title = `${name} v${version}`;

  // Inline styles with !important so the page's own CSS can't override them.
  badge.style.cssText = `
    position: fixed !important;
    left: 16px !important;
    bottom: 16px !important;
    z-index: 2147483647 !important;
    padding: 8px 14px !important;
    border-radius: 8px !important;
    background: #1f2937 !important;
    color: #ffffff !important;
    font: 600 14px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
    pointer-events: none !important;
  `;

  return badge;
}

function injectBadge(): void {
  // Guard against injecting twice (e.g. if the script is re-run).
  if (document.getElementById(BADGE_ID)) return;
  (document.body ?? document.documentElement).appendChild(createBadge());
}

injectBadge();
