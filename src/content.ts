// Content script for www.ceskatelevize.cz and ct24.ceskatelevize.cz.
//
// Adds a floating Play/Pause button to the bottom-left corner of the page that
// controls the iVysílání player. The player renders an ordinary <video>
// element straight into the page (no iframe, no shadow DOM), so the button
// drives it through the HTMLMediaElement API.
//
// Both sites are single-page apps, and on video-on-demand pages the <video>
// element only appears once the poster's play button has been clicked. The
// script therefore watches the DOM with a MutationObserver and re-attaches to
// whichever player is currently on the page.

import browser from "webextension-polyfill";

const BUTTON_ID = "ivysilani-ext-play-pause";

/** The player's own <video> lives inside this wrapper on both sites. */
const PLAYER_VIDEO_SELECTOR = ".playerPageWrapper video";

/** The big play button shown over the poster before a video-on-demand player is loaded. */
const POSTER_PLAY_BUTTON_SELECTOR = 'button[aria-label^="Přehrát video"]';

/** Video events after which the button label may need to change. */
const VIDEO_STATE_EVENTS = ["play", "playing", "pause", "ended", "emptied"] as const;

const LABELS = {
  play: { text: "▶ Play", aria: "Play video" },
  pause: { text: "⏸ Pause", aria: "Pause video" },
} as const;

let video: HTMLVideoElement | null = null;
let button: HTMLButtonElement | null = null;

function area(el: Element): number {
  return el.clientWidth * el.clientHeight;
}

function findVideo(): HTMLVideoElement | null {
  const inPlayer = document.querySelector<HTMLVideoElement>(PLAYER_VIDEO_SELECTOR);
  if (inPlayer) return inPlayer;

  // Fallback in case the player's markup changes: take the largest <video>.
  let largest: HTMLVideoElement | null = null;
  for (const candidate of document.querySelectorAll("video")) {
    if (!largest || area(candidate) > area(largest)) largest = candidate;
  }
  return largest;
}

function findPosterPlayButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(POSTER_PLAY_BUTTON_SELECTOR);
}

async function togglePlayback(): Promise<void> {
  if (video) {
    if (video.paused) {
      try {
        await video.play();
      } catch (error) {
        console.warn("[ivysilani-web-extension] play() was rejected:", error);
      }
    } else {
      video.pause();
    }
    return;
  }

  // No player on the page yet: start it the same way a user would.
  findPosterPlayButton()?.click();
}

function createButton(): HTMLButtonElement {
  const { name, version } = browser.runtime.getManifest();

  const el = document.createElement("button");
  el.id = BUTTON_ID;
  el.type = "button";
  el.title = `${name} v${version}`;

  // Inline styles with !important so the page's own CSS can't override them.
  el.style.cssText = `
    position: fixed !important;
    left: 16px !important;
    bottom: 16px !important;
    z-index: 2147483647 !important;
    display: none !important;
    align-items: center !important;
    margin: 0 !important;
    padding: 8px 14px !important;
    border: 0 !important;
    border-radius: 8px !important;
    background: #1f2937 !important;
    color: #ffffff !important;
    font: 600 14px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
    cursor: pointer !important;
  `;

  el.addEventListener("click", () => {
    void togglePlayback();
  });

  return el;
}

/** Updates the button's label and visibility to match the player's state. */
function render(): void {
  if (!button) return;

  const playing = video !== null && !video.paused;
  const hasPlayer = video !== null || findPosterPlayButton() !== null;
  const label = playing ? LABELS.pause : LABELS.play;

  // Only touch the DOM when something changed, so our own updates don't
  // trigger the MutationObserver in a loop.
  if (button.textContent !== label.text) button.textContent = label.text;
  if (button.getAttribute("aria-label") !== label.aria) button.setAttribute("aria-label", label.aria);
  button.style.setProperty("display", hasPlayer ? "inline-flex" : "none", "important");
}

function attachVideo(next: HTMLVideoElement | null): void {
  if (next === video) return;

  for (const event of VIDEO_STATE_EVENTS) video?.removeEventListener(event, render);
  video = next;
  for (const event of VIDEO_STATE_EVENTS) video?.addEventListener(event, render);
}

/** Makes sure the button is mounted and bound to the player currently on the page. */
function sync(): void {
  if (!button) button = createButton();
  if (!button.isConnected) (document.body ?? document.documentElement).appendChild(button);

  attachVideo(findVideo());
  render();
}

// The sites mutate the DOM constantly, so coalesce bursts of mutations into
// a single sync() call.
let syncScheduled = false;

function scheduleSync(records: MutationRecord[]): void {
  if (syncScheduled) return;
  if (button && records.every((record) => button!.contains(record.target))) return;

  syncScheduled = true;
  setTimeout(() => {
    syncScheduled = false;
    sync();
  }, 100);
}

sync();
new MutationObserver(scheduleSync).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
