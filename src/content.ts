// Content script for www.ceskatelevize.cz and ct24.ceskatelevize.cz.
//
// Adds a floating control bar to the bottom-left corner of the page with a
// Play/Pause button and playback-speed controls for the iVysílání player. The
// player renders an ordinary <video> element straight into the page (no
// iframe, no shadow DOM), so the controls drive it through the
// HTMLMediaElement API.
//
// Both sites are single-page apps, and on video-on-demand pages the <video>
// element only appears once the poster's play button has been clicked. The
// script therefore watches the DOM with a MutationObserver and re-attaches to
// whichever player is currently on the page.

import browser from "webextension-polyfill";

const BAR_ID = "ivysilani-ext-bar";

/** The player's own <video> lives inside this wrapper on both sites. */
const PLAYER_VIDEO_SELECTOR = ".playerPageWrapper video";

/** The big play button shown over the poster before a video-on-demand player is loaded. */
const POSTER_PLAY_BUTTON_SELECTOR = 'button[aria-label^="Přehrát video"]';

const RATE_DEFAULT = 1;
const RATE_STEP = 0.25;
const RATE_MIN = 0.25;
const RATE_MAX = 3;

/** Video events after which the controls may need re-rendering. */
const VIDEO_STATE_EVENTS = ["play", "playing", "pause", "ended", "emptied", "ratechange"] as const;

/**
 * Events after which the player may have silently reset playbackRate to 1,
 * e.g. when it switches from the pre-roll ad to the programme (same <video>
 * element, new source) or when it recovers from buffering.
 */
const VIDEO_RATE_RESET_EVENTS = ["loadedmetadata", "playing"] as const;

const LABELS = {
  play: { text: "▶ Play", aria: "Play video" },
  pause: { text: "⏸ Pause", aria: "Pause video" },
} as const;

// Inline styles with !important so the page's own CSS can't override them.
const BUTTON_STYLE = `
  display: inline-flex !important;
  align-items: center !important;
  margin: 0 !important;
  padding: 8px 12px !important;
  border: 0 !important;
  border-radius: 8px !important;
  background: #1f2937 !important;
  color: #ffffff !important;
  font: 600 14px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
  cursor: pointer !important;
`;

interface Controls {
  bar: HTMLDivElement;
  playPause: HTMLButtonElement;
  speedGroup: HTMLSpanElement;
  slower: HTMLButtonElement;
  rate: HTMLButtonElement;
  faster: HTMLButtonElement;
}

let video: HTMLVideoElement | null = null;
let controls: Controls | null = null;

/** The speed the user asked for; re-applied whenever the player resets it. */
let desiredRate = RATE_DEFAULT;

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

// --- Playback ---------------------------------------------------------------

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

// --- Playback speed ---------------------------------------------------------

function clampRate(rate: number): number {
  const snapped = Math.round(rate / RATE_STEP) * RATE_STEP;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, snapped));
}

/** Formats 1 → "1×", 1.5 → "1.5×", 1.25 → "1.25×". */
function formatRate(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, "")}×`;
}

/** The rate the player is really using, or the desired one before a player exists. */
function currentRate(): number {
  return video ? video.playbackRate : desiredRate;
}

function applyDesiredRate(): void {
  if (video && video.playbackRate !== desiredRate) video.playbackRate = desiredRate;
}

/** Restores the user's speed after the player reset it; leaves the player alone at 1×. */
function reapplyDesiredRate(): void {
  if (desiredRate !== RATE_DEFAULT) applyDesiredRate();
}

function setRate(rate: number): void {
  desiredRate = clampRate(rate);
  applyDesiredRate();
  render();
}

// --- UI ---------------------------------------------------------------------

function createButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  el.title = title;
  el.style.cssText = BUTTON_STYLE;
  el.addEventListener("click", onClick);
  return el;
}

function createControls(): Controls {
  const { name, version } = browser.runtime.getManifest();

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.title = `${name} v${version}`;
  bar.style.cssText = `
    position: fixed !important;
    left: 16px !important;
    bottom: 16px !important;
    z-index: 2147483647 !important;
    display: none !important;
    align-items: center !important;
    gap: 6px !important;
    margin: 0 !important;
    padding: 0 !important;
  `;

  const playPause = createButton(LABELS.play.text, "Play / pause", () => {
    void togglePlayback();
  });

  const speedGroup = document.createElement("span");
  speedGroup.style.cssText = `
    display: none !important;
    align-items: center !important;
    gap: 6px !important;
  `;
  const slower = createButton("−", `Slower (−${RATE_STEP}×)`, () => setRate(currentRate() - RATE_STEP));
  const rate = createButton(formatRate(RATE_DEFAULT), "Playback speed – click to reset to 1×", () =>
    setRate(RATE_DEFAULT),
  );
  const faster = createButton("+", `Faster (+${RATE_STEP}×)`, () => setRate(currentRate() + RATE_STEP));
  speedGroup.append(slower, rate, faster);

  bar.append(playPause, speedGroup);
  return { bar, playPause, speedGroup, slower, rate, faster };
}

// Only touch the DOM when something changed, so our own updates don't
// trigger the MutationObserver in a loop.
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setAttribute(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setDisplay(el: HTMLElement, value: string): void {
  el.style.setProperty("display", value, "important");
}

function setDisabled(el: HTMLButtonElement, disabled: boolean): void {
  if (el.disabled === disabled) return;
  el.disabled = disabled;
  el.style.setProperty("opacity", disabled ? "0.5" : "1", "important");
  el.style.setProperty("cursor", disabled ? "default" : "pointer", "important");
}

/** Updates the controls' labels and visibility to match the player's state. */
function render(): void {
  if (!controls) return;

  const hasVideo = video !== null;
  const hasPlayer = hasVideo || findPosterPlayButton() !== null;
  const playing = video !== null && !video.paused;
  const rate = currentRate();
  const label = playing ? LABELS.pause : LABELS.play;

  setDisplay(controls.bar, hasPlayer ? "flex" : "none");
  setText(controls.playPause, label.text);
  setAttribute(controls.playPause, "aria-label", label.aria);

  // Speed can only be changed once there is a <video> to apply it to.
  setDisplay(controls.speedGroup, hasVideo ? "inline-flex" : "none");
  setText(controls.rate, formatRate(rate));
  setDisabled(controls.slower, rate <= RATE_MIN);
  setDisabled(controls.faster, rate >= RATE_MAX);
}

// --- Wiring -----------------------------------------------------------------

function attachVideo(next: HTMLVideoElement | null): void {
  if (next === video) return;

  if (video) {
    for (const event of VIDEO_STATE_EVENTS) video.removeEventListener(event, render);
    for (const event of VIDEO_RATE_RESET_EVENTS) video.removeEventListener(event, reapplyDesiredRate);
  }

  video = next;

  if (video) {
    for (const event of VIDEO_STATE_EVENTS) video.addEventListener(event, render);
    for (const event of VIDEO_RATE_RESET_EVENTS) video.addEventListener(event, reapplyDesiredRate);
    reapplyDesiredRate();
  }
}

/** Makes sure the controls are mounted and bound to the player currently on the page. */
function sync(): void {
  if (!controls) controls = createControls();
  if (!controls.bar.isConnected) (document.body ?? document.documentElement).appendChild(controls.bar);

  attachVideo(findVideo());
  render();
}

// The sites mutate the DOM constantly, so coalesce bursts of mutations into
// a single sync() call.
let syncScheduled = false;

function scheduleSync(records: MutationRecord[]): void {
  if (syncScheduled) return;
  const bar = controls?.bar;
  if (bar && records.every((record) => bar.contains(record.target))) return;

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
