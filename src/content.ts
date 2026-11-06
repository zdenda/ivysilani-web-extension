// Content script for www.ceskatelevize.cz and ct24.ceskatelevize.cz.
//
// Adds a floating control bar to the bottom-left corner of the page with a
// Play/Pause button, playback-speed controls and a label estimating when
// playback reaches the end of the programme (or the live edge of a live
// stream) at the current speed. On live streams it also shows, while paused,
// how long the paused position stays inside the time-shift window, and it
// guards the resume: if the player jumps ahead of the paused position, it is
// seeked back. The iVysílání player renders an ordinary <video> element
// straight into the page (no iframe, no shadow DOM), so the controls drive it
// through the HTMLMediaElement API.
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

/** Events that only move the ETA label; they fire several times a second while playing. */
const VIDEO_TICK_EVENTS = ["timeupdate", "durationchange"] as const;

/** The player's own "go to live" button; a resume through it must not be "corrected". */
const LIVE_BUTTON_SELECTOR = 'button[title="Přejít na živé vysílání"]';

/**
 * Where shaka-player puts the playhead when it is outside the seekable window
 * (its safeSeekOffset): just inside the window start.
 */
const LIVE_SAFE_OFFSET = 5;

/** A resume that lands this many seconds ahead of the expected position counts as a jump. */
const RESUME_JUMP_TOLERANCE = 10;

/** How long after a resume the guard keeps watching for a late jump. */
const RESUME_GUARD_MS = 10_000;

/** The player's own UI; a click in it after a resume means the user took over. */
const PLAYER_SELECTOR = ".playerPageWrapper";

const LOG_PREFIX = "[ivysilani-web-extension]";

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

/** Same pill as the buttons, but it is only read, not clicked. */
const LABEL_STYLE = `${BUTTON_STYLE}
  cursor: default !important;
  white-space: nowrap !important;
`;

interface Controls {
  bar: HTMLDivElement;
  playPause: HTMLButtonElement;
  speedGroup: HTMLSpanElement;
  slower: HTMLButtonElement;
  rate: HTMLButtonElement;
  faster: HTMLButtonElement;
  eta: HTMLSpanElement;
  buffer: HTMLSpanElement;
}

/** Published by page.ts (which runs in the page's world) through a data attribute on <html>. */
interface BufferStatus {
  active: boolean;
  goal: number | null;
  wanted: number;
  how: string;
  version: string | null;
}

const BUFFER_STATUS_DATASET_KEY = "ivysilaniExtBuffer";

let video: HTMLVideoElement | null = null;
let controls: Controls | null = null;

/** The speed the user asked for; re-applied whenever the player resets it. */
let desiredRate = RATE_DEFAULT;

/** Length of the live stream's time-shift window in seconds, measured while playing. */
let liveWindow: number | null = null;

/** Where the user paused a live stream, while it is paused. */
let pausedAt: number | null = null;
let pausedWall = 0;

/** Armed on resume: the position to get back to, until when to watch for a jump, and whether the verdict was logged. */
let resumeGuard: { remembered: number; until: number; reported: boolean } | null = null;

/** Set when the user clicks the player's "live" button while paused. */
let userWentLive = false;

/**
 * While the video is paused no timeupdate events arrive, yet the pause-budget
 * countdown keeps moving and the player keeps filling its buffer, so a
 * one-second ticker refreshes those labels instead.
 */
let pauseTicker: number | null = null;

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

// --- Time to the end / live edge --------------------------------------------

interface Eta {
  /** "end" of a video-on-demand programme, or the live "edge" of a live stream. */
  kind: "end" | "edge";
  /** Wall-clock seconds until playback gets there at the current speed. */
  seconds: number;
}

/** Live streams report an infinite duration. */
function isLive(v: HTMLVideoElement): boolean {
  return v.duration === Infinity;
}

/** The live edge is the end of the seekable range. */
function liveEdge(v: HTMLVideoElement): number | null {
  const ranges = v.seekable.length;
  return ranges > 0 ? v.seekable.end(ranges - 1) : null;
}

/**
 * When playback reaches the end of the programme or the live edge at the
 * current speed, or null when it never will (paused, 1× on a live stream, ...).
 */
function computeEta(v: HTMLVideoElement): Eta | null {
  const rate = v.playbackRate;
  if (v.paused || v.ended || rate <= 0) return null;

  if (v.duration === Infinity) {
    // Live: every second of playback closes the gap to the edge by (rate − 1) s.
    const edge = liveEdge(v);
    if (edge === null || rate <= 1) return null;
    return { kind: "edge", seconds: Math.max(0, (edge - v.currentTime) / (rate - 1)) };
  }

  if (!Number.isFinite(v.duration)) return null;
  return { kind: "end", seconds: Math.max(0, (v.duration - v.currentTime) / rate) };
}

/** 21:47 in the viewer's locale. */
function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Rounded to minutes: "1 h 23 min", "3 h", "23 min", "< 1 min". */
function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return m > 0 ? `${m} min` : "< 1 min";
}

/** Ticking countdown: "1:04", "1:02:03". */
function formatCountdown(seconds: number): string {
  const total = Math.ceil(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// --- Live time-shift window: pause budget and resume guard -------------------
//
// ČT live streams come in two flavours: the plain live stream keeps only
// ~76 s of time-shift, the time-shift stream (used as soon as you rewind)
// keeps 3 h. Both windows slide forward in real time. The player remembers
// the position where you paused and seeks back to it on resume, but if that
// position has meanwhile left the window, shaka-player clamps the playhead to
// the oldest available point, and the stream appears to "skip forward".

/**
 * Measures the window length while playing. `video.seekable.start` is the
 * lower of shaka's window start and the start of the back-buffer, so it is
 * only trusted when the buffer starts later than it; the measurement is
 * replaced outright when it changes by more than the back-buffer can explain
 * (the player switched between the two stream flavours).
 */
function updateLiveWindow(v: HTMLVideoElement): void {
  if (!isLive(v) || v.paused || v.seekable.length === 0) return;

  const start = v.seekable.start(0);
  const raw = v.seekable.end(v.seekable.length - 1) - start;
  const unmasked = v.buffered.length > 0 && v.buffered.start(0) > start + 1;
  if (unmasked || liveWindow === null || Math.abs(raw - liveWindow) > 60) liveWindow = raw;
}

/**
 * The oldest position still inside the window. Derived from the live edge,
 * which keeps moving while paused, unlike `seekable.start`, which is frozen
 * by the back-buffer during a pause.
 */
function liveWindowStart(v: HTMLVideoElement): number | null {
  const edge = liveEdge(v);
  return liveWindow === null || edge === null ? null : edge - liveWindow;
}

/** Seconds until the paused position leaves the window; negative once it has. */
function pauseBudget(v: HTMLVideoElement): number | null {
  const start = liveWindowStart(v);
  return pausedAt === null || start === null ? null : pausedAt - LIVE_SAFE_OFFSET - start;
}

function startPauseTicker(): void {
  if (pauseTicker !== null) return;
  pauseTicker = window.setInterval(() => {
    renderEta();
    renderBuffer();
  }, 1000);
}

function stopPauseTicker(): void {
  if (pauseTicker === null) return;
  clearInterval(pauseTicker);
  pauseTicker = null;
}

function describe(v: HTMLVideoElement): string {
  const start = liveWindowStart(v)?.toFixed(1) ?? "?";
  const edge = liveEdge(v)?.toFixed(1) ?? "?";
  return `position ${v.currentTime.toFixed(1)} s, window ${start} – ${edge} s`;
}

/** 'pause': remember where the user stopped and start the countdown. */
function onLivePause(): void {
  if (!video || !isLive(video)) return;
  pausedAt = video.currentTime;
  pausedWall = Date.now();
  resumeGuard = null;
  userWentLive = false;
  console.info(`${LOG_PREFIX} paused live stream: ${describe(video)}`);
}

/** 'seeking' while paused: the user moved the slider, so that is the new remembered position. */
function onLiveSeeking(): void {
  if (!video || pausedAt === null || !video.paused) return;
  pausedAt = video.currentTime;
}

/** 'play': arm the guard with the remembered position and log what the resume starts from. */
function onLivePlay(): void {
  if (!video || pausedAt === null || !isLive(video)) return;
  const elapsed = Math.round((Date.now() - pausedWall) / 1000);
  console.info(`${LOG_PREFIX} resuming after ${elapsed} s: remembered ${pausedAt.toFixed(1)} s, ${describe(video)}`);
  resumeGuard = { remembered: pausedAt, until: Date.now() + RESUME_GUARD_MS, reported: false };
  pausedAt = null;
}

/** 'emptied' / 'loadstart' while paused or resuming: the player reloaded the stream. */
function onLiveReload(event: Event): void {
  const remembered = pausedAt ?? resumeGuard?.remembered;
  if (remembered === undefined || remembered === null) return;
  console.info(`${LOG_PREFIX} stream reloaded (${event.type}) while resuming from ${remembered.toFixed(1)} s`);
}

/**
 * 'playing' / 'seeked' while the guard is armed. The player may settle in
 * several steps (seek to the remembered position, then clamp to the window),
 * so this runs on each of them: if the playhead ends up well ahead of the
 * remembered position although that position (or at least an older one) is
 * still available, seek back.
 */
function checkLiveResume(event: Event): void {
  if (!video || !resumeGuard || !isLive(video)) return;

  if (Date.now() > resumeGuard.until) {
    resumeGuard = null;
    return;
  }
  if (userWentLive) {
    console.info(`${LOG_PREFIX} resumed via the live button, leaving the player alone`);
    resumeGuard = null;
    return;
  }

  const start = liveWindowStart(video);
  const target = start === null ? resumeGuard.remembered : Math.max(resumeGuard.remembered, start + LIVE_SAFE_OFFSET);
  const landed = video.currentTime;
  if (landed <= target + RESUME_JUMP_TOLERANCE) {
    // The player may fire 'playing' more than once; report the verdict only the first time.
    if (event.type === "playing" && !resumeGuard.reported) {
      resumeGuard.reported = true;
      console.info(`${LOG_PREFIX} resumed at ${landed.toFixed(1)} s (expected ≈ ${target.toFixed(1)} s), fine`);
    }
    return;
  }

  console.warn(`${LOG_PREFIX} resume jumped to ${landed.toFixed(1)} s, expected ≈ ${target.toFixed(1)} s; seeking back`);
  resumeGuard = null;
  video.currentTime = target;
}

/** Clicks on the player's "live" button are honoured; any other click in the player after a resume disarms the guard. */
function onDocumentClick(event: Event): void {
  if (pausedAt === null && !resumeGuard) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(LIVE_BUTTON_SELECTOR)) {
    userWentLive = true;
  } else if (resumeGuard && target?.closest(PLAYER_SELECTOR)) {
    resumeGuard = null;
  }
}

/** A key press after a resume (arrow keys seek in the player) disarms the guard too. */
function onDocumentKeydown(): void {
  resumeGuard = null;
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

  const eta = document.createElement("span");
  eta.style.cssText = LABEL_STYLE;
  setDisplay(eta, "none");

  const buffer = document.createElement("span");
  buffer.style.cssText = LABEL_STYLE;
  setDisplay(buffer, "none");

  bar.append(playPause, speedGroup, eta, buffer);
  return { bar, playPause, speedGroup, slower, rate, faster, eta, buffer };
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

  if (hasVideo && !playing) startPauseTicker();
  else stopPauseTicker();

  // Speed can only be changed once there is a <video> to apply it to.
  setDisplay(controls.speedGroup, hasVideo ? "inline-flex" : "none");
  setText(controls.rate, formatRate(rate));
  setDisabled(controls.slower, rate <= RATE_MIN);
  setDisabled(controls.faster, rate >= RATE_MAX);

  renderEta();
  renderBuffer();
}

/** While a live stream is paused, the label shows how long the paused position stays available. */
function renderPauseBudget(v: HTMLVideoElement): boolean {
  if (!controls || !v.paused || !isLive(v)) return false;
  const budget = pauseBudget(v);
  if (budget === null || liveWindow === null) return false;

  const window_ = formatMinutes(liveWindow);
  if (budget > 0) {
    const countdown = formatCountdown(budget);
    setText(controls.eta, `resume within ${countdown}`);
    setAttribute(
      controls.eta,
      "title",
      `The time-shift window keeps ${window_}. Your paused position leaves it at ${formatClock(new Date(Date.now() + budget * 1000))}; after that the player resumes at the oldest available point instead.`,
    );
  } else {
    setText(controls.eta, "position expired");
    setAttribute(
      controls.eta,
      "title",
      `Your paused position has left the ${window_} time-shift window; the player will resume about ${formatCountdown(-budget)} later than where you paused.`,
    );
  }
  setDisplay(controls.eta, "inline-flex");
  return true;
}

/** Updates the ETA label; cheap enough to run on every timeupdate. */
function renderEta(): void {
  if (!controls) return;

  if (video && renderPauseBudget(video)) return;

  const eta = video ? computeEta(video) : null;
  if (!video || !eta) {
    setDisplay(controls.eta, "none");
    return;
  }

  const at = formatClock(new Date(Date.now() + eta.seconds * 1000));
  const rate = formatRate(video.playbackRate);

  if (eta.kind === "edge") {
    const countdown = formatCountdown(eta.seconds);
    setText(controls.eta, `live in ${countdown}`);
    setAttribute(controls.eta, "title", `At ${rate} you reach the live edge at ${at}, in ${countdown}.`);
  } else {
    const minutes = formatMinutes(eta.seconds);
    setText(controls.eta, `ends ${at} · ${minutes}`);
    setAttribute(controls.eta, "title", `At ${rate} the programme ends at ${at}, in ${minutes}.`);
  }
  setDisplay(controls.eta, "inline-flex");
}

// --- Wiring -----------------------------------------------------------------

// --- Buffer label -------------------------------------------------------------

/** Seconds of media buffered ahead of the playhead. */
function bufferedAhead(v: HTMLVideoElement): number {
  const ranges = v.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= v.currentTime + 0.5 && ranges.end(i) >= v.currentTime) return ranges.end(i) - v.currentTime;
  }
  return 0;
}

function readBufferStatus(): BufferStatus | null {
  const raw = document.documentElement.dataset[BUFFER_STATUS_DATASET_KEY];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BufferStatus;
  } catch {
    return null;
  }
}

function renderBuffer(): void {
  if (!controls) return;
  if (!video) {
    setDisplay(controls.buffer, "none");
    return;
  }

  setText(controls.buffer, `buffer ${Math.round(bufferedAhead(video))} s`);

  const status = readBufferStatus();
  const player = status?.version ? ` (player ${status.version})` : "";
  const title = !status
    ? "Seconds buffered ahead of the playhead."
    : status.active
      ? `Seconds buffered ahead of the playhead. The extension asks the player for ${status.wanted} s: ${status.how}${player}.`
      : `Seconds buffered ahead of the playhead. The extension could not raise the player's buffer to ${status.wanted} s: ${status.how}${player}.`;
  setAttribute(controls.buffer, "title", title);
  setDisplay(controls.buffer, "inline-flex");
}

function onTick(): void {
  if (video) updateLiveWindow(video);
  renderEta();
  renderBuffer();
}

// Listeners for the live time-shift logic; registered before the render
// listeners so that render() sees the updated state.
const LIVE_LISTENERS: ReadonlyArray<[string, (event: Event) => void]> = [
  ["pause", onLivePause],
  ["seeking", onLiveSeeking],
  ["play", onLivePlay],
  ["playing", checkLiveResume],
  ["seeked", checkLiveResume],
  ["emptied", onLiveReload],
  ["loadstart", onLiveReload],
];

function attachVideo(next: HTMLVideoElement | null): void {
  if (next === video) return;

  if (video) {
    for (const [event, listener] of LIVE_LISTENERS) video.removeEventListener(event, listener);
    for (const event of VIDEO_STATE_EVENTS) video.removeEventListener(event, render);
    for (const event of VIDEO_RATE_RESET_EVENTS) video.removeEventListener(event, reapplyDesiredRate);
    for (const event of VIDEO_TICK_EVENTS) video.removeEventListener(event, onTick);
    stopPauseTicker();
  }

  // A new <video> element keeps a pending resume (the app may swap elements
  // while reloading the stream) but needs its own window measurement.
  video = next;
  liveWindow = null;

  if (video) {
    for (const [event, listener] of LIVE_LISTENERS) video.addEventListener(event, listener);
    for (const event of VIDEO_STATE_EVENTS) video.addEventListener(event, render);
    for (const event of VIDEO_RATE_RESET_EVENTS) video.addEventListener(event, reapplyDesiredRate);
    for (const event of VIDEO_TICK_EVENTS) video.addEventListener(event, onTick);
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
document.addEventListener("click", onDocumentClick, true);
document.addEventListener("keydown", onDocumentKeydown, true);
