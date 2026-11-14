// Content script for www.ceskatelevize.cz and ct24.ceskatelevize.cz.
//
// Adds a floating control bar to the bottom-left corner of the page with a
// Play/Pause button, playback-speed controls and a label estimating when
// playback reaches the end of the programme (or the live edge of a live
// stream) at the current speed. On live streams it also shows, while paused,
// how long the paused position stays inside the time-shift window, and it
// guards the resume: if the player jumps ahead of the paused position, it is
// seeked back. The , and . keys step one frame back / forward, J / L and
// ← / → seek 10 s / 5 s, as on YouTube; on a live stream a rewind that leaves
// the short live window switches the player to its time-shift stream first.
// The iVysílání player renders an ordinary <video> element straight into the
// page (no iframe, no shadow DOM), so the controls drive it through the
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

/** Events that start a (re)load of the stream, during which that reset happens. */
const VIDEO_RELOAD_EVENTS = ["emptied", "loadstart"] as const;

/** How long a change to 1× must last, with no reload following, to count as a choice. */
const RATE_DEFAULT_CONFIRM_MS = 2000;

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

/** Frame stepping keys, as on YouTube. */
const FRAME_BACK_KEY = ",";
const FRAME_FORWARD_KEY = ".";

/** Seek keys, as on YouTube: arrows 5 s, J / L 10 s. */
const SEEK_SMALL_SECONDS = 5;
const SEEK_LARGE_SECONDS = 10;
const SEEK_KEYS: Readonly<Record<string, number>> = {
  ArrowLeft: -SEEK_SMALL_SECONDS,
  ArrowRight: SEEK_SMALL_SECONDS,
  j: -SEEK_LARGE_SECONDS,
  l: SEEK_LARGE_SECONDS,
};

/** Never seek closer to the live edge than this; the player has nothing to show there yet. */
const LIVE_EDGE_MARGIN = 3;

/** What the player's slider spans on a live stream: the 3 h time-shift window. */
const TIME_SHIFT_SPAN = 10_800;

/**
 * The slider lands only roughly (a pixel is ~20 s and the player adds its
 * own offsets), so the switch asks for this much further back than needed
 * and the exact position is reached with a seek afterwards.
 */
const TIME_SHIFT_OVERSHOOT = 120;

/**
 * The player rounds the slider to whole percent of its 3 h and treats 99 %
 * as "still live" (it then seeks inside the plain stream and clamps), so a
 * request must be at least this far back to land at 98 % or less.
 */
const TIME_SHIFT_MIN_REQUEST = 250;
const STREAM_SWITCH_TIMEOUT_MS = 10_000;

/**
 * After the switch the player itself seeks to where its slider was clicked.
 * Normally that happens before this script places the playhead, but under
 * load it can arrive later and undo the placement. For this long after the
 * placement, a playhead that gets moved elsewhere is put back.
 */
const LANDING_GUARD_MS = 8000;

/** How far (in seconds) from where playback could have got to counts as "moved elsewhere". */
const LANDING_TOLERANCE = 3;

/** The guard gives up after this many corrections rather than fight the player. */
const LANDING_MAX_CORRECTIONS = 2;

/**
 * A pause on the plain live stream that lasts longer than this moves the
 * paused position to the time-shift stream, whose 3 h window keeps it; on
 * the plain stream it would leave the ~75 s window within a minute.
 */
const PAUSE_TO_TIME_SHIFT_MS = 3000;

/** How long after a real click or key press a 'play' or 'pause' counts as the user's doing. */
const USER_GESTURE_MS = 1000;
const SLIDER_SELECTOR = `${PLAYER_SELECTOR} [role="slider"]`;

/** How long the player needs to render its controls after a mouse move (React renders on the next frame). */
const CONTROLS_RENDER_MS = 300;

/** Used until the real frame rate has been measured (European TV is 25 or 50 fps). */
const DEFAULT_FRAME_RATE = 25;

/** Playback needed for one frame-rate measurement, in media seconds. */
const FRAME_RATE_WINDOW = 2;

/** A measurement within 3 % of one of these is snapped to it. */
const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

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
  seekGroup: HTMLSpanElement;
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

/**
 * The speed the user asked for, through this bar or through the player's own
 * settings menu; re-applied whenever the player resets it.
 */
let desiredRate = RATE_DEFAULT;

/** True from a (re)load of the stream until playback starts again. */
let rateResetPending = false;

/** Running while a change to 1× waits to be confirmed as a choice (see onRateChange). */
let defaultRateTimer: number | null = null;

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
 * A rewind that is waiting for the player to switch to its time-shift stream.
 * `wantedPaused` is the play state to end up in: the one the switch started
 * from, unless the user plays or pauses in the meantime (see noteUserPlayState).
 */
let pendingTimeShift: { behindLive: number; wantedPaused: boolean; startedAt: number; from: number } | null = null;

/** When the user last really clicked or pressed a key (scripted events do not count). */
let lastUserGesture = 0;

/** The page path the live-stream state above belongs to (see dropLiveStateOnNavigation). */
let livePath = location.pathname;

/**
 * Armed once the playhead has been placed on the time-shift stream: the last
 * position known to be ours and when it was seen, until when to watch, and
 * how often the playhead has been put back.
 */
let landingGuard: {
  video: HTMLVideoElement;
  position: number;
  seenAt: number;
  until: number;
  corrections: number;
} | null = null;

/** Scheduled move of a paused position from the plain live stream to the time-shift stream. */
let pauseSwitchTimer: number | null = null;

/**
 * While the video is paused no timeupdate events arrive, yet the pause-budget
 * countdown keeps moving and the player keeps filling its buffer, so a
 * one-second ticker refreshes those labels instead.
 */
let pauseTicker: number | null = null;

/** Media time of the last frame requestVideoFrameCallback reported; any sample fixes the frame grid's phase. */
let lastFrameMediaTime: number | null = null;
let frameCallbackHandle: number | null = null;
/** Frames per second measured from the decoded-frame counter, once enough playback has been seen. */
let measuredFrameRate: number | null = null;
/** Start of the current measurement window: decoded frames and media time. */
let frameRateWindow: { frames: number; time: number } | null = null;

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
  // While a change to 1× waits to be confirmed as a choice, the speed is left alone.
  if (defaultRateTimer !== null) return;
  if (desiredRate !== RATE_DEFAULT) applyDesiredRate();
}

function cancelDefaultRateConfirmation(): void {
  if (defaultRateTimer === null) return;
  clearTimeout(defaultRateTimer);
  defaultRateTimer = null;
}

function onStreamReload(): void {
  rateResetPending = true;
  // A 1× seen just before this was the player's reset, not a choice.
  cancelDefaultRateConfirmation();
}

function onRateRestore(event: Event): void {
  // A speed picked in the player's menu just now counts even if this event
  // overtook its `ratechange`; without this the pick would be undone below.
  onRateChange();
  reapplyDesiredRate();
  if (event.type === "playing") rateResetPending = false;
}

/**
 * Follows a speed that something other than this bar has set, in practice the
 * player's own settings menu, so that the bar's steps and the re-application
 * after a reset continue from it. (The other direction, the player's menu
 * showing a speed set here, is page.ts's job.)
 *
 * Any speed but 1× can only be a deliberate choice and is adopted at once.
 * 1× is ambiguous: it is what "normal speed" in the menu sets, and also what
 * the browser and the player library put back whenever a stream is reloaded
 * or the player is torn down – the library even does so a moment *before*
 * the reload becomes visible. So 1× during a reload is ignored (that is the
 * reset this script undoes), and 1× outside one is adopted only after it has
 * lasted RATE_DEFAULT_CONFIRM_MS with no reload and no new player.
 */
function onRateChange(): void {
  if (!video) return;
  const rate = video.playbackRate;
  // 0 is the player library holding playback while it buffers, not a speed.
  if (!(rate > 0)) return;
  if (rate !== RATE_DEFAULT) cancelDefaultRateConfirmation();
  if (rate === desiredRate) return;
  if (rate !== RATE_DEFAULT) {
    desiredRate = rate;
    return;
  }

  if (rateResetPending || video.readyState === 0 || defaultRateTimer !== null) return;
  const changed = video;
  defaultRateTimer = window.setTimeout(() => {
    defaultRateTimer = null;
    const stillChosen =
      video === changed &&
      changed.isConnected &&
      !rateResetPending &&
      changed.readyState > 0 &&
      changed.playbackRate === RATE_DEFAULT;
    if (stillChosen) desiredRate = RATE_DEFAULT;
  }, RATE_DEFAULT_CONFIRM_MS);
}

function setRate(rate: number): void {
  desiredRate = clampRate(rate);
  cancelDefaultRateConfirmation();
  applyDesiredRate();
  render();
}

// --- Frame stepping -----------------------------------------------------------
//
// The frame rate comes from the decoded-frame counter
// (getVideoPlaybackQuality().totalVideoFrames) over a stretch of playback:
// it counts every frame, however rarely a throttled tab paints. Frames sit on
// a regular grid, and any media time reported by requestVideoFrameCallback,
// even a stale one, fixes the grid's phase; a step then seeks to the middle
// of the neighbouring frame on that grid, which cannot land on a boundary.

/** timeupdate while playing: one frame-rate measurement per FRAME_RATE_WINDOW seconds of playback. */
function sampleFrameRate(v: HTMLVideoElement): void {
  if (v.paused || typeof v.getVideoPlaybackQuality !== "function") return;
  const now = { frames: v.getVideoPlaybackQuality().totalVideoFrames, time: v.currentTime };
  if (!frameRateWindow) {
    frameRateWindow = now;
    return;
  }

  const seconds = now.time - frameRateWindow.time;
  const frames = now.frames - frameRateWindow.frames;
  if (seconds < 0 || frames < 0) {
    frameRateWindow = now;
    return;
  }
  if (seconds < FRAME_RATE_WINDOW) return;

  const raw = frames / seconds;
  measuredFrameRate = COMMON_FRAME_RATES.find((rate) => Math.abs(rate - raw) / rate < 0.03) ?? raw;
  frameRateWindow = now;
}

/** A seek decodes extra frames from the previous keyframe, which must not count. */
function resetFrameRateWindow(): void {
  frameRateWindow = null;
}

function onVideoFrame(_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void {
  frameCallbackHandle = null;
  if (!video) return;
  lastFrameMediaTime = metadata.mediaTime;
  frameCallbackHandle = video.requestVideoFrameCallback(onVideoFrame);
}

function startFrameTracking(v: HTMLVideoElement): void {
  if (typeof v.requestVideoFrameCallback !== "function") return;
  frameCallbackHandle = v.requestVideoFrameCallback(onVideoFrame);
}

function stopFrameTracking(v: HTMLVideoElement): void {
  if (frameCallbackHandle !== null && typeof v.cancelVideoFrameCallback === "function") v.cancelVideoFrameCallback(frameCallbackHandle);
  frameCallbackHandle = null;
  lastFrameMediaTime = null;
  measuredFrameRate = null;
  frameRateWindow = null;
}

/** The measured frame duration, or the default until enough playback has been seen. */
function frameDuration(): number {
  return 1 / (measuredFrameRate ?? DEFAULT_FRAME_RATE);
}

/** Moves one frame back or forward; pauses first if the video is playing. */
function stepFrame(direction: -1 | 1): void {
  if (!video) return;
  if (!video.paused) video.pause();

  const duration = frameDuration();
  const phase = lastFrameMediaTime === null ? 0 : lastFrameMediaTime % duration;
  // Frame k spans [phase + k·d, phase + (k+1)·d); aim for the middle of frame k ± 1.
  const current = Math.floor((video.currentTime - phase) / duration + 1e-6);
  video.currentTime = Math.max(0, phase + (current + direction + 0.5) * duration);
}

/** Is the key press typing in a field, which must be left to the page? */
function isTypingTarget(event: Event): boolean {
  // For a field inside a shadow tree the event's target is the tree's host;
  // the first entry of the composed path is the element really typed into.
  const target = event.composedPath()[0] ?? event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

// --- Seeking by a few seconds -----------------------------------------------
//
// Live streams come in two flavours (see the time-shift section below). The
// player's own skip button and arrow keys seek 10 s on the plain live stream
// and are silently clamped at its window start, about 67 s behind live; only
// a click on its slider makes it load the 3 h time-shift stream. So a rewind
// that would leave the plain window is done by clicking that slider from
// script, further back than needed, and seeking forward to the exact point
// once the new stream plays.

function seekBy(seconds: number): void {
  if (!video) return;
  const v = video;
  const from = v.currentTime;
  landingGuard = null; // a deliberate move, not one to undo

  if (!isLive(v)) {
    const max = Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.5) : Infinity;
    v.currentTime = Math.min(max, Math.max(0, from + seconds));
    return;
  }

  const edge = estimatedLiveEdge(v);
  if (edge === null) return;
  if (seconds >= 0) {
    v.currentTime = Math.min(from + seconds, (liveEdge(v) ?? edge) - LIVE_EDGE_MARGIN);
    return;
  }

  const target = from + seconds;
  const start = liveWindowStart(v) ?? v.seekable.start(0);
  // The player clamps anything below start + safeSeekOffset.
  const floor = start + LIVE_SAFE_OFFSET + 1;
  if (target >= floor) {
    v.currentTime = target;
    return;
  }
  void switchToTimeShift(edge - target);
}

/**
 * Makes the player render its controls (they are not in the DOM while
 * hidden) and returns its slider.
 *
 * The player shows the controls when the mouse moves over an overlay that
 * covers the picture. The overlay is a sibling of the <video>, not an
 * ancestor, so the event has to go to the overlay itself or to something
 * inside it. Which element that is cannot be read from the player's React
 * props here: this script runs in the extension's isolated world, where the
 * properties the page's JavaScript puts on DOM nodes are invisible.
 * Hit-testing finds it instead: the overlay is whatever lies on top in the
 * middle of the picture. If that does not work (the player is scrolled out
 * of view, or something covers it), every leaf element of the player gets
 * the event; mouse moves bubble, so the overlay is reached through one of
 * them wherever it sits.
 */
async function revealSlider(): Promise<Element | null> {
  const present = findTimeline();
  if (present) return present;

  const wrapper = document.querySelector(PLAYER_SELECTOR);
  if (!wrapper) return null;
  const frame = (video ?? wrapper).getBoundingClientRect();
  const at = { clientX: frame.left + frame.width / 2, clientY: frame.top + frame.height / 2 };

  const attempts: Element[][] = [];
  const onTop = document.elementFromPoint(at.clientX, at.clientY);
  if (onTop && wrapper.contains(onTop)) attempts.push([onTop]);
  attempts.push([...wrapper.querySelectorAll("*")].filter((el) => el.childElementCount === 0));

  for (const targets of attempts) {
    for (const target of targets) {
      target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, ...at }));
    }
    await new Promise((resolve) => setTimeout(resolve, CONTROLS_RENDER_MS));
    const slider = findTimeline();
    if (slider) return slider;
  }
  return null;
}

/** The player's timeline. Its volume control is a slider too, so of the sliders it is the widest. */
function findTimeline(): Element | null {
  let widest: Element | null = null;
  for (const slider of document.querySelectorAll(SLIDER_SELECTOR)) {
    if (!widest || slider.getBoundingClientRect().width > widest.getBoundingClientRect().width) widest = slider;
  }
  return widest;
}

/** The innermost part of `root` that spans the point, or `root` itself. */
function innermostAt(root: Element, x: number, y: number): Element {
  let innermost = root;
  // Descendants follow their ancestors in document order, so the last match is the deepest.
  for (const el of root.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) innermost = el;
  }
  return innermost;
}

/** A click on the slider track at the given fraction of its width (0 = oldest, 1 = live). */
function clickSlider(slider: Element, fraction: number): void {
  const r = slider.getBoundingClientRect();
  const x = r.left + r.width * fraction;
  const y = r.top + r.height / 2;
  // The events go to the part of the slider under the point, as a real click
  // would. If something else lies on top there (this extension's own bar
  // can), that must not get the click, so the slider's part is looked up by
  // its position instead.
  const onTop = document.elementFromPoint(x, y);
  const target = onTop && slider.contains(onTop) ? onTop : innermostAt(slider, x, y);
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith("down") ? 1 : 0 };
    target.dispatchEvent(
      type.startsWith("pointer")
        ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
        : new MouseEvent(type, init),
    );
  }
}

async function switchToTimeShift(behindLive: number): Promise<void> {
  if (!video || pendingTimeShift) return;
  // Marked as pending before the wait below, so that a second key press in
  // the meantime cannot start a second switch.
  const pending = { behindLive, wantedPaused: video.paused, startedAt: Date.now(), from: video.currentTime };
  pendingTimeShift = pending;

  const slider = await revealSlider();
  if (pendingTimeShift !== pending) return; // the user left the page meanwhile
  if (!slider) {
    pendingTimeShift = null;
    console.warn(`${LOG_PREFIX} cannot rewind past the live window: the player's slider was not found`);
    return;
  }

  const asked = Math.min(Math.max(behindLive + TIME_SHIFT_OVERSHOOT, TIME_SHIFT_MIN_REQUEST), TIME_SHIFT_SPAN - 60);
  // This is a deliberate move, not a resume to guard.
  resumeGuard = null;
  pausedAt = null;
  console.info(`${LOG_PREFIX} ${behindLive.toFixed(0)} s behind live is outside the live window; switching to the time-shift stream (asking the slider for ${asked.toFixed(0)} s)`);
  clickSlider(slider, 1 - asked / TIME_SHIFT_SPAN);

  window.setTimeout(() => {
    if (!pendingTimeShift || Date.now() - pendingTimeShift.startedAt < STREAM_SWITCH_TIMEOUT_MS) return;
    const { from, wantedPaused: paused } = pendingTimeShift;
    pendingTimeShift = null;
    console.warn(`${LOG_PREFIX} the player did not switch to the time-shift stream`);
    // The click may still have moved the playhead inside the plain stream: put it back as far as the window allows.
    if (video && onPlainLiveStream(video)) {
      const floor = (liveWindowStart(video) ?? video.seekable.start(0)) + LIVE_SAFE_OFFSET + 1;
      const restored = Math.max(from, floor);
      if (Math.abs(video.currentTime - restored) > 1) video.currentTime = restored;
      if (paused) {
        if (!video.paused) video.pause();
        pausedAt = restored;
      }
    }
  }, STREAM_SWITCH_TIMEOUT_MS);
}

/**
 * After the switch the player settles in several steps (it loads the stream
 * at the start of the window, seeks to the live edge, then to the slider
 * position, and plays only if it was playing). Each of these events on the
 * time-shift stream restarts a short timer; when the player has been quiet
 * for that long, seek to the exact point and restore the paused state. A
 * step that still arrives later is undone by the landing guard below.
 */
let settleTimer: number | null = null;
const SETTLE_MS = 700;

function onTimeShiftEvent(): void {
  if (!pendingTimeShift || !video || !isLive(video) || video.seekable.length === 0) return;
  if (video.seekable.end(0) - video.seekable.start(0) < 1000) return; // still the plain stream
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = window.setTimeout(finishTimeShift, SETTLE_MS);
}

function finishTimeShift(): void {
  settleTimer = null;
  if (!pendingTimeShift || !video || video.seekable.length === 0) return;
  const v = video;
  const { wantedPaused, startedAt } = pendingTimeShift;
  // The requested content moment keeps falling further behind live while the
  // switch takes its few seconds, so the distance is anchored to wall-clock time.
  const behindLive = pendingTimeShift.behindLive + (Date.now() - startedAt) / 1000;
  pendingTimeShift = null;

  const span = v.seekable.end(0) - v.seekable.start(0);
  liveWindow = span; // the stream changed; a paused player would not measure it otherwise
  edgeTrack = null; // and so did the timeline
  const target = (estimatedLiveEdge(v) ?? v.seekable.end(0)) - behindLive;
  console.info(`${LOG_PREFIX} time-shift stream loaded ${(v.seekable.end(0) - v.currentTime).toFixed(0)} s behind live (${v.paused ? "paused" : "playing"}); seeking to ${behindLive.toFixed(0)} s behind`);
  if (Math.abs(v.currentTime - target) > 1) v.currentTime = target;
  landingGuard = { video: v, position: target, seenAt: Date.now(), until: Date.now() + LANDING_GUARD_MS, corrections: 0 };
  if (wantedPaused) {
    if (!v.paused) v.pause();
    // The player may already be paused, so no 'pause' event records the position for the countdown and the resume guard.
    pausedAt = target;
    pausedWall = pausedWall || Date.now();
  } else if (v.paused) {
    void v.play().catch(() => undefined);
  }
}

/** The armed guard for this video, or null; an expired or outdated guard is dropped. */
function activeLandingGuard(v: HTMLVideoElement): NonNullable<typeof landingGuard> | null {
  if (!landingGuard) return null;
  if (landingGuard.video !== v || Date.now() > landingGuard.until || !isLive(v)) {
    landingGuard = null;
    return null;
  }
  return landingGuard;
}

/** Is the playhead where playback from the guarded position could have taken it by now? */
function isOnLanding(v: HTMLVideoElement, guard: NonNullable<typeof landingGuard>): boolean {
  const played = ((Date.now() - guard.seenAt) / 1000) * Math.max(1, v.playbackRate);
  return v.currentTime >= guard.position - LANDING_TOLERANCE && v.currentTime <= guard.position + played + LANDING_TOLERANCE;
}

/** Runs on every tick: follows the playhead for as long as it simply plays on (or stays paused). */
function trackLanding(v: HTMLVideoElement): void {
  const guard = activeLandingGuard(v);
  if (!guard || v.seeking || !isOnLanding(v, guard)) return;
  guard.position = v.currentTime;
  guard.seenAt = Date.now();
}

/**
 * 'seeked' while the guard is armed. A seek that took the playhead somewhere
 * playback could not have reached is the player's late seek to its slider
 * position (the user's own seeks disarm the guard first), so it is undone.
 */
function checkLanding(): void {
  if (!video) return;
  const guard = activeLandingGuard(video);
  if (!guard || isOnLanding(video, guard)) return;
  if (guard.corrections >= LANDING_MAX_CORRECTIONS) {
    landingGuard = null;
    return;
  }
  guard.corrections++;
  guard.seenAt = Date.now();
  const edge = liveEdge(video) ?? video.currentTime;
  console.warn(`${LOG_PREFIX} the player moved the playhead to ${(edge - video.currentTime).toFixed(0)} s behind live after the switch; seeking back to ${(edge - guard.position).toFixed(0)} s behind`);
  video.currentTime = guard.position;
}

/** Is the player on the plain live stream (as opposed to the 3 h time-shift stream)? */
function onPlainLiveStream(v: HTMLVideoElement): boolean {
  return isLive(v) && v.seekable.length > 0 && v.seekable.end(0) - v.seekable.start(0) < 1000;
}

/** 'pause' on the plain live stream: unless it is a brief tap, move the position to the time-shift stream. */
function schedulePauseSwitch(): void {
  cancelPauseSwitch();
  if (!video || !onPlainLiveStream(video)) return;
  pauseSwitchTimer = window.setTimeout(() => {
    pauseSwitchTimer = null;
    if (!video || !video.paused || pausedAt === null || !onPlainLiveStream(video)) return;
    const behindLive = (estimatedLiveEdge(video) ?? video.seekable.end(0)) - pausedAt;
    console.info(`${LOG_PREFIX} still paused after ${PAUSE_TO_TIME_SHIFT_MS / 1000} s on the plain live stream (${behindLive.toFixed(0)} s behind live); moving to the time-shift stream so the position survives the pause`);
    void switchToTimeShift(behindLive);
  }, PAUSE_TO_TIME_SHIFT_MS);
}

function cancelPauseSwitch(): void {
  if (pauseSwitchTimer === null) return;
  clearTimeout(pauseSwitchTimer);
  pauseSwitchTimer = null;
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
 * The player moves the seekable end in whole segments (3.84 s on ČT), so a
 * raw reading can be stale by up to a segment. The edge is therefore tracked
 * against wall-clock time: it grows one second per second between steps.
 */
let edgeTrack: { value: number; wall: number } | null = null;

function trackLiveEdge(v: HTMLVideoElement): void {
  const edge = liveEdge(v);
  if (edge === null) return;
  if (!edgeTrack || edge > edgeTrack.value + 0.01) edgeTrack = { value: edge, wall: Date.now() };
}

function estimatedLiveEdge(v: HTMLVideoElement): number | null {
  const edge = liveEdge(v);
  if (edge === null) return null;
  trackLiveEdge(v);
  return edgeTrack ? Math.max(edge, edgeTrack.value + (Date.now() - edgeTrack.wall) / 1000) : edge;
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
  if (!isLive(v) || v.seekable.length === 0) return;

  const start = v.seekable.start(0);
  const raw = v.seekable.end(v.seekable.length - 1) - start;
  // A stream switch (plain ↔ time-shift) is unmistakable even while paused.
  if (liveWindow === null || Math.abs(raw - liveWindow) > 60) {
    liveWindow = raw;
    return;
  }
  if (v.paused) return;
  const unmasked = v.buffered.length > 0 && v.buffered.start(0) > start + 1;
  if (unmasked) liveWindow = raw;
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
    if (video) trackLiveEdge(video);
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

/**
 * 'play' / 'pause' while a stream switch is pending. If it follows a real
 * click or key press made after the switch began, the user did it, and that
 * is the state the switch has to end in rather than the one it started from.
 * The player's own play() after it has loaded the new stream follows no
 * gesture, and the key press that started the switch came before it, so
 * neither changes anything.
 */
function noteUserPlayState(paused: boolean): void {
  if (!pendingTimeShift) return;
  if (lastUserGesture <= pendingTimeShift.startedAt || Date.now() - lastUserGesture > USER_GESTURE_MS) return;
  pendingTimeShift.wantedPaused = paused;
}

/**
 * The sites are single-page apps: going to another channel keeps this script
 * running and often the <video> element too. A paused position, a pending
 * resume or a stream switch from the previous page must not act on the new one.
 */
function dropLiveStateOnNavigation(): void {
  if (location.pathname === livePath) return;
  livePath = location.pathname;
  pausedAt = null;
  resumeGuard = null;
  pendingTimeShift = null;
  landingGuard = null;
  userWentLive = false;
  cancelPauseSwitch();
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

/** 'pause': remember where the user stopped and start the countdown. */
function onLivePause(): void {
  noteUserPlayState(true);
  if (!video || !isLive(video)) return;
  pausedAt = video.currentTime;
  pausedWall = Date.now();
  resumeGuard = null;
  userWentLive = false;
  console.info(`${LOG_PREFIX} paused live stream: ${describe(video)}`);
  schedulePauseSwitch();
}

/** 'seeking' while paused: the user moved the slider, so that is the new remembered position. */
function onLiveSeeking(): void {
  if (!video || pausedAt === null || !video.paused) return;
  pausedAt = video.currentTime;
}

/** 'play': arm the guard with the remembered position and log what the resume starts from. */
function onLivePlay(): void {
  noteUserPlayState(false);
  cancelPauseSwitch();
  dropLiveStateOnNavigation();
  if (!video || pausedAt === null || !isLive(video)) return;
  const elapsed = Math.round((Date.now() - pausedWall) / 1000);
  console.info(`${LOG_PREFIX} resuming after ${elapsed} s: remembered ${pausedAt.toFixed(1)} s, ${describe(video)}`);
  resumeGuard = { remembered: pausedAt, until: Date.now() + RESUME_GUARD_MS, reported: false };
  pausedAt = null;
}

/** 'emptied' / 'loadstart' while paused or resuming: the player reloaded the stream. */
function onLiveReload(event: Event): void {
  dropLiveStateOnNavigation();
  edgeTrack = null;
  landingGuard = null; // positions on the old stream mean nothing on the new one
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
  dropLiveStateOnNavigation();
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
  if (event.isTrusted) lastUserGesture = Date.now();
  if (pausedAt === null && !resumeGuard && !landingGuard) return;
  const target = event.target instanceof Element ? event.target : null;
  // A click in the player right after a stream switch is the user moving on.
  if (target?.closest(PLAYER_SELECTOR)) landingGuard = null;
  if (target?.closest(LIVE_BUTTON_SELECTOR)) {
    userWentLive = true;
  } else if (resumeGuard && target?.closest(PLAYER_SELECTOR)) {
    resumeGuard = null;
  }
}

/**
 * , and . step one frame back / forward. Any key press after a resume (arrow
 * keys seek in the player) disarms the resume guard too.
 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.isTrusted) lastUserGesture = Date.now();
  resumeGuard = null;
  landingGuard = null;

  if (!video || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event)) return;
  // Shift with an arrow key extends a text selection; that stays with the page.
  if (event.shiftKey && event.key.startsWith("Arrow")) return;

  const seek = SEEK_KEYS[event.key] ?? SEEK_KEYS[event.key.toLowerCase()];
  if (seek !== undefined) {
    event.preventDefault();
    event.stopPropagation(); // the player's own arrow-key seek would run and be clamped
    seekBy(seek);
    return;
  }

  if (event.key !== FRAME_BACK_KEY && event.key !== FRAME_FORWARD_KEY) return;
  event.preventDefault();
  event.stopPropagation();
  stepFrame(event.key === FRAME_FORWARD_KEY ? 1 : -1);
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
  bar.title = `${name} v${version} – keys: J / L seek ${SEEK_LARGE_SECONDS} s, ← / → seek ${SEEK_SMALL_SECONDS} s, ${FRAME_BACK_KEY} / ${FRAME_FORWARD_KEY} step one frame`;
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

  const seekGroup = document.createElement("span");
  seekGroup.style.cssText = `
    display: none !important;
    align-items: center !important;
    gap: 6px !important;
  `;
  const back = createButton(`« ${SEEK_LARGE_SECONDS} s`, `Back ${SEEK_LARGE_SECONDS} s (J; ← = ${SEEK_SMALL_SECONDS} s)`, () => seekBy(-SEEK_LARGE_SECONDS));
  const forward = createButton(`${SEEK_LARGE_SECONDS} s »`, `Forward ${SEEK_LARGE_SECONDS} s (L; → = ${SEEK_SMALL_SECONDS} s)`, () => seekBy(SEEK_LARGE_SECONDS));
  seekGroup.append(back, forward);

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
  // Wide enough for the longest label ("0.25×") so that − and + stay put
  // while the speed changes. (`font` in BUTTON_STYLE resets the numeric
  // variant, so it has to be set afterwards.)
  rate.style.cssText += `
    box-sizing: border-box !important;
    min-width: calc(5ch + 24px) !important;
    justify-content: center !important;
    font-variant-numeric: tabular-nums !important;
  `;
  speedGroup.append(slower, rate, faster);

  const eta = document.createElement("span");
  eta.style.cssText = LABEL_STYLE;
  setDisplay(eta, "none");

  const buffer = document.createElement("span");
  buffer.style.cssText = LABEL_STYLE;
  setDisplay(buffer, "none");

  bar.append(playPause, seekGroup, speedGroup, eta, buffer);
  return { bar, playPause, seekGroup, speedGroup, slower, rate, faster, eta, buffer };
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

  // Seeking and speed need a <video> to act on.
  setDisplay(controls.seekGroup, hasVideo ? "inline-flex" : "none");
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
  if (video) {
    trackLiveEdge(video);
    updateLiveWindow(video);
    sampleFrameRate(video);
    trackLanding(video);
  }
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
  ["loadedmetadata", onTimeShiftEvent],
  ["canplay", onTimeShiftEvent],
  ["seeked", onTimeShiftEvent],
  ["playing", onTimeShiftEvent],
  // The player's seeks after a switch can supersede one another, so that only 'seeking' fires in between.
  ["seeking", onTimeShiftEvent],
  ["seeked", checkLanding],
  ["emptied", onLiveReload],
  ["loadstart", onLiveReload],
];

function attachVideo(next: HTMLVideoElement | null): void {
  if (next === video) return;

  if (video) {
    for (const [event, listener] of LIVE_LISTENERS) video.removeEventListener(event, listener);
    for (const event of VIDEO_STATE_EVENTS) video.removeEventListener(event, render);
    video.removeEventListener("ratechange", onRateChange);
    for (const event of VIDEO_RELOAD_EVENTS) video.removeEventListener(event, onStreamReload);
    for (const event of VIDEO_RATE_RESET_EVENTS) video.removeEventListener(event, onRateRestore);
    for (const event of VIDEO_TICK_EVENTS) video.removeEventListener(event, onTick);
    video.removeEventListener("seeking", resetFrameRateWindow);
    stopPauseTicker();
    stopFrameTracking(video);
    cancelPauseSwitch();
  }

  // A 1× the old player was left at is its teardown, not a choice.
  cancelDefaultRateConfirmation();

  // A new <video> element keeps a pending resume (the app may swap elements
  // while reloading the stream) but needs its own window and edge measurements.
  video = next;
  liveWindow = null;
  edgeTrack = null;

  if (video) {
    for (const [event, listener] of LIVE_LISTENERS) video.addEventListener(event, listener);
    // Registered before the render listeners so that render() sees the adopted speed.
    video.addEventListener("ratechange", onRateChange);
    for (const event of VIDEO_RELOAD_EVENTS) video.addEventListener(event, onStreamReload);
    for (const event of VIDEO_STATE_EVENTS) video.addEventListener(event, render);
    for (const event of VIDEO_RATE_RESET_EVENTS) video.addEventListener(event, onRateRestore);
    for (const event of VIDEO_TICK_EVENTS) video.addEventListener(event, onTick);
    video.addEventListener("seeking", resetFrameRateWindow);
    // A player that has not started playing yet is still inside its load.
    rateResetPending = video.readyState === 0 || video.paused;
    reapplyDesiredRate();
    startFrameTracking(video);
  }
}

/** Makes sure the controls are mounted and bound to the player currently on the page. */
function sync(): void {
  if (!controls) {
    // When the extension is reloaded or updated, Firefox runs this script
    // again in the tabs that are already open. The earlier copy is gone by
    // then, but the bar it built is still in the page, and nothing drives it.
    document.getElementById(BAR_ID)?.remove();
    controls = createControls();
  }
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
// A drag on the player's slider seeks before any click event arrives.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (landingGuard && event.target instanceof Element && event.target.closest(PLAYER_SELECTOR)) landingGuard = null;
  },
  true,
);
