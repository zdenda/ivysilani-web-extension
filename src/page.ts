// Page-world script for www.ceskatelevize.cz and ct24.ceskatelevize.cz.
//
// Runs in the page's own JavaScript world (manifest `"world": "MAIN"`), not in
// the isolated content-script world, because the video player library lives
// in the page's module scope. It has two jobs: ask the player to buffer further
// ahead than its default 10 s, so that short network outages pass unnoticed,
// and keep the speed shown in the player's own settings menu equal to the
// speed the <video> element really plays at (see "The speed the player shows").
//
// Nothing here depends on one particular page build. The player class is
// located through several independent strategies (a global, the webpack
// registry, the Turbopack registry), every player instance gets the setting
// whenever it loads a stream, the setting is re-asserted if the page
// reconfigures the player, and the outcome is published for the control bar
// (a data attribute on <html>) and logged to the console. If the site changes
// and no player is found, the bar shows "inactive" instead of the extension
// breaking silently.

const BUFFER_GOAL_SECONDS = 120;
const LOG_PREFIX = "[ivysilani-web-extension/page]";

/** `document.documentElement.dataset` key the control bar reads the status from. */
const STATUS_DATASET_KEY = "ivysilaniExtBuffer";

const SEARCH_INTERVAL_MS = 500;

// --- One copy at a time ------------------------------------------------------
//
// When the extension is reloaded or updated, Firefox runs its content scripts
// again in the tabs that are already open. A script in the isolated world is
// torn down together with the old extension, but this one runs in the page's
// own world, where its timers, listeners and hooks live on. The old copy and
// the new one would then both act on the same player, and wherever the two
// versions behave differently they would work against each other. So every
// copy announces itself when it starts, and a copy that finds a later
// announcement stops acting.

/** Where the copies of this script in one page leave the id of the latest one. */
const LATEST_COPY_KEY = Symbol.for("ivysilani-web-extension/page/latest-copy");
const COPY_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const copyRegistry = globalThis as unknown as Record<symbol, unknown>;
copyRegistry[LATEST_COPY_KEY] = COPY_ID;

/** What stops this copy's timers and listeners. Its hooks stay in place and pass every call through. */
const stoppers: Array<() => void> = [];
let retired = false;

/**
 * Is this still the latest copy in the page? Everything that acts asks first;
 * the first "no" also stops this copy's timers and listeners.
 */
function inCharge(): boolean {
  if (retired) return false;
  if (copyRegistry[LATEST_COPY_KEY] === COPY_ID) return true;
  retired = true;
  for (const stop of stoppers.splice(0)) stop();
  console.info(`${LOG_PREFIX} a newer copy of this script has taken over, this one has stopped`);
  return false;
}

/** The subset of the shaka.Player API this script relies on (duck-typed, never imported). */
interface PlayerLike {
  configure(config: unknown, value?: unknown): unknown;
  getConfiguration(): { streaming?: { bufferingGoal?: number } } | undefined;
  load(...args: unknown[]): Promise<unknown>;
  getMediaElement?(): Element | null;
}

interface PlayerClass {
  prototype: PlayerLike;
  version?: string;
}

interface BufferStatus {
  active: boolean;
  /** What the player reports after our configure() call, or null when no player was reached. */
  goal: number | null;
  wanted: number;
  how: string;
  version: string | null;
}

/** Minimal view of webpack's require function, as handed to a chunk's runtime callback. */
interface WebpackRequire {
  (id: string): unknown;
  m?: Record<string, unknown>;
}

/** Minimal view of the context Turbopack hands to a module factory. */
interface TurbopackContext {
  /** require by module id */
  r?: (id: unknown) => unknown;
  /** module factories */
  M?: Map<unknown, unknown> | Record<string, unknown>;
  /** module cache */
  c?: Map<unknown, { exports?: unknown }> | Record<string, { exports?: unknown }>;
}

let playerClass: PlayerClass | null = null;
let playerClassOrigin = "";

/** Instances already configured; the hooks must not reconfigure in a loop. */
const seen = new WeakSet<PlayerLike>();
let applying = false;

/** <video> elements whose player has been configured; the others trigger the instance search. */
const handledVideos = new WeakSet<Element>();
let lastInstanceSearch = 0;
const INSTANCE_SEARCH_INTERVAL_MS = 5000;

// --- Status ------------------------------------------------------------------

function publish(status: BufferStatus): void {
  document.documentElement.dataset[STATUS_DATASET_KEY] = JSON.stringify(status);
}

// --- Applying the setting ----------------------------------------------------

function isPlayerLike(value: unknown): value is PlayerLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["configure"] === "function" &&
    typeof candidate["getConfiguration"] === "function" &&
    typeof candidate["load"] === "function"
  );
}

function isPlayerClass(value: unknown): value is PlayerClass {
  return typeof value === "function" && isPlayerLike((value as { prototype?: unknown }).prototype);
}

function applyTo(player: PlayerLike, how: string): void {
  seen.add(player);
  applying = true;
  try {
    player.configure({ streaming: { bufferingGoal: BUFFER_GOAL_SECONDS } });
  } catch (error) {
    console.warn(`${LOG_PREFIX} configure() failed (${how}):`, error);
    publish({ active: false, goal: null, wanted: BUFFER_GOAL_SECONDS, how: `configure() failed: ${String(error)}`, version: version() });
    return;
  } finally {
    applying = false;
  }

  let goal: number | null = null;
  try {
    goal = player.getConfiguration()?.streaming?.bufferingGoal ?? null;
  } catch {
    // Reported as inactive below.
  }
  const active = goal === BUFFER_GOAL_SECONDS;
  console.info(`${LOG_PREFIX} buffering goal ${active ? "set to" : "NOT applied, player reports"} ${goal} s (${how})`);
  publish({ active, goal, wanted: BUFFER_GOAL_SECONDS, how, version: version() });

  try {
    const element = player.getMediaElement?.();
    if (element) handledVideos.add(element);
  } catch {
    // The instance search will simply run again.
  }
}

function noteInstance(player: PlayerLike, how: string): void {
  if (!seen.has(player)) applyTo(player, how);
}

function version(): string | null {
  return playerClass?.version ?? null;
}

/** Does this configure() call touch the buffering goal (object form or "path", value form)? */
function touchesBufferingGoal(config: unknown, value: unknown): boolean {
  if (typeof config === "string") return config === "streaming.bufferingGoal" || (config === "streaming" && touchesBufferingGoal({ streaming: value }, undefined));
  if (!config || typeof config !== "object") return false;
  const streaming = (config as { streaming?: unknown }).streaming;
  return !!streaming && typeof streaming === "object" && "bufferingGoal" in streaming;
}

/**
 * Hooks the player class so that every instance, present and future, gets the
 * setting: on each stream load, after any page call that changes the goal,
 * and whenever an instance shows up through any method we wrap.
 */
function installHooks(cls: PlayerClass, how: string): void {
  const proto = cls.prototype;
  const originalLoad = proto.load;
  const originalConfigure = proto.configure;
  const originalGetConfiguration = proto.getConfiguration;

  proto.load = function (this: PlayerLike, ...args: unknown[]): Promise<unknown> {
    if (inCharge()) applyTo(this, `${how}; on stream load`);
    return originalLoad.apply(this, args);
  };

  proto.configure = function (this: PlayerLike, config: unknown, value?: unknown): unknown {
    const result = originalConfigure.call(this, config, value);
    if (inCharge() && !applying && touchesBufferingGoal(config, value)) applyTo(this, `${how}; re-asserted after the page reconfigured it`);
    return result;
  };

  proto.getConfiguration = function (this: PlayerLike) {
    if (inCharge()) noteInstance(this, `${how}; existing instance`);
    return originalGetConfiguration.call(this);
  };

  console.info(`${LOG_PREFIX} hooked the player class (${how}, version ${cls.version ?? "unknown"})`);
}

// --- Finding the player class ------------------------------------------------

/** Strategy 1: the library is exposed globally (shaka's own builds do this when loaded as a script). */
function findViaGlobal(): PlayerClass | null {
  const shaka = (globalThis as Record<string, unknown>)["shaka"];
  const candidate = shaka && typeof shaka === "object" ? (shaka as Record<string, unknown>)["Player"] : null;
  return isPlayerClass(candidate) ? candidate : null;
}

/** The player library's module is recognised by its source: it is the one mentioning these config keys. */
function looksLikePlayerModule(source: string): boolean {
  return source.includes("bufferingGoal") && source.includes("rebufferingGoal") && source.includes("Player");
}

/** The class is exported as `Player` on the module's exports, or on its default export. */
function playerClassFromExports(exported: unknown): PlayerClass | null {
  const record = exported && typeof exported === "object" ? (exported as Record<string, unknown>) : null;
  for (const candidate of [record, record?.["default"]]) {
    const cls = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>)["Player"] : null;
    if (isPlayerClass(cls)) return cls;
  }
  return null;
}

let webpackRequire: WebpackRequire | null = null;
let webpackProbePushed = false;
const webpackScanned = new Set<string>();

/**
 * Has the bundler's runtime taken its chunk registry over? Until it starts,
 * the registry is a plain array in which the page's chunks queue up, and the
 * runtime works through that queue while the page loads. A probe must never
 * sit in that queue: if the site moved to a registry format the probe does
 * not fit, the runtime would trip over it and the page would not load. Once
 * the runtime has replaced the array's `push` with its own function, the
 * probe is handled inside our own call, where any error is caught and only
 * this script's search fails.
 */
function runtimeOwns(registry: { push?: unknown }): boolean {
  return typeof registry.push === "function" && registry.push !== Array.prototype.push;
}

/**
 * Strategy 2: the page is bundled with webpack (www.ceskatelevize.cz today).
 * Pushing a fake chunk into the chunk registry hands us webpack's require
 * function; the player library is then recognised by its source and required
 * (it is already loaded by the time the player runs, so this returns its
 * cached exports).
 */
function findViaWebpack(): PlayerClass | null {
  if (!webpackRequire) {
    const key = Object.keys(self).find((k) => k.startsWith("webpackChunk"));
    const chunks = key ? (self as unknown as Record<string, unknown>)[key] : null;
    if (!Array.isArray(chunks) || !runtimeOwns(chunks)) return null;
    if (!webpackProbePushed) {
      webpackProbePushed = true;
      chunks.push([[Symbol(LOG_PREFIX)], {}, (require: WebpackRequire) => {
        webpackRequire = require;
      }]);
    }
    if (!webpackRequire) return null;
  }

  const factories = webpackRequire.m;
  if (!factories) return null;

  for (const id of Object.keys(factories)) {
    if (webpackScanned.has(id)) continue;
    webpackScanned.add(id);
    if (!looksLikePlayerModule(String(factories[id]))) continue;
    try {
      const cls = playerClassFromExports(webpackRequire(id));
      if (cls) return cls;
    } catch (error) {
      console.warn(`${LOG_PREFIX} could not load webpack module ${id}:`, error);
    }
  }
  return null;
}

// The runtime runs a module only once, so every copy of this script (see "One
// copy at a time") needs a probe under a name of its own.
const TURBOPACK_PROBE_MODULE = `ivysilani-ext-probe-${COPY_ID}`;
const TURBOPACK_PROBE_CHUNK = `${TURBOPACK_PROBE_MODULE}.js`;
let turbopackContext: TurbopackContext | null = null;
let turbopackProbePushed = false;
const turbopackScanned = new Set<unknown>();

/**
 * Strategy 3: the page is bundled with Turbopack (ct24.ceskatelevize.cz
 * today). Its chunk registry accepts a flat `[path, moduleId, factory]`
 * entry, and a `[path, { runtimeModuleIds }]` entry makes the runtime run
 * that module (asynchronously) with a context that exposes the module
 * factories and cache. The player library is then recognised by its source
 * as above.
 */
function findViaTurbopack(): PlayerClass | null {
  const globals = globalThis as Record<string, unknown>;
  if (!turbopackContext) {
    const nameHint = globals["__TURBOPACK_CHUNK_LOADING_GLOBAL"];
    const registry = globals[typeof nameHint === "string" ? nameHint : "TURBOPACK"] as { push?: (chunk: unknown) => unknown } | undefined;
    if (!registry || !runtimeOwns(registry) || typeof registry.push !== "function") return null;
    if (!turbopackProbePushed) {
      turbopackProbePushed = true;
      registry.push([TURBOPACK_PROBE_CHUNK, TURBOPACK_PROBE_MODULE, (context: TurbopackContext) => {
        turbopackContext = context;
      }]);
      registry.push([TURBOPACK_PROBE_CHUNK, { otherChunks: [], runtimeModuleIds: [TURBOPACK_PROBE_MODULE] }]);
    }
    // The runtime runs the probe asynchronously; a later pass continues from here.
    return null;
  }

  const factories = turbopackContext.M;
  if (!factories) return null;
  const entries = factories instanceof Map ? [...factories.entries()] : Object.entries(factories);

  for (const [id, factory] of entries) {
    if (turbopackScanned.has(id)) continue;
    turbopackScanned.add(id);
    if (!looksLikePlayerModule(String(factory))) continue;
    try {
      const cache = turbopackContext.c;
      const cached = cache instanceof Map ? cache.get(id) : cache?.[String(id)];
      const cls = playerClassFromExports(cached?.exports ?? turbopackContext.r?.(id));
      if (cls) return cls;
    } catch (error) {
      console.warn(`${LOG_PREFIX} could not load Turbopack module ${String(id)}:`, error);
    }
  }
  return null;
}

// --- Finding instances that already exist ------------------------------------

/**
 * Strategy A: the page exposes debugging helpers that call into the player
 * (ceskatelevize.cz has `window.shakaUtils`). Any global object with a
 * getConfiguration() function is poked; the hooked prototype method then
 * sees the instance.
 */
function pokeGlobalHelpers(): void {
  for (const key of Object.keys(self)) {
    try {
      const value = (self as unknown as Record<string, unknown>)[key];
      if (!value || typeof value !== "object") continue;
      // Cross-origin frames are window properties too, and even reading a
      // property on them throws, so everything stays inside the try.
      const helper = (value as Record<string, unknown>)["getConfiguration"];
      if (typeof helper === "function") helper.call(value);
    } catch {
      // Not the helper we hoped for.
    }
  }
}

/** Strategy B: walk React's fiber tree around the given <video> elements looking for an instance of the class. */
function scanReactFibers(cls: PlayerClass, videos: Element[]): void {
  for (const video of videos) {
    const fiberKey = Object.keys(video).find((k) => k.startsWith("__reactFiber$"));
    if (!fiberKey) continue;
    let fiber = (video as unknown as Record<string, unknown>)[fiberKey] as Record<string, unknown> | null;
    const visited = new Set<unknown>();
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber["return"] as Record<string, unknown> | null) {
      for (const root of [fiber["memoizedProps"], fiber["stateNode"], fiber["memoizedState"]]) {
        const found = findInstance(root, cls, visited, 0);
        if (found) {
          noteInstance(found, `${playerClassOrigin}; found through React`);
          return;
        }
      }
    }
  }
}

function findInstance(value: unknown, cls: PlayerClass, visited: Set<unknown>, depth: number): PlayerLike | null {
  if (!value || typeof value !== "object" || visited.has(value) || depth > 4 || value instanceof Node) return null;
  visited.add(value);
  if (value instanceof (cls as unknown as abstract new () => PlayerLike) && isPlayerLike(value)) return value;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return null;
  }
  for (const key of keys.slice(0, 80)) {
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    const found = findInstance(child, cls, visited, depth + 1);
    if (found) return found;
  }
  // React hooks form a linked list through `next`, which Object.keys covers.
  return null;
}

// --- The speed the player shows -------------------------------------------------
//
// The player keeps the speed it *shows* in its settings menu in React state (a
// context value with `playbackRate` and `setPlaybackRate`), separate from the
// <video> element's real `playbackRate`. Its menu sets both; anything else –
// the extension's speed buttons, or the extension restoring the speed after
// the player reset it – only changes the element, and the menu then shows a
// stale value. Copying the element's rate into that state after every change
// keeps the menu truthful, whoever changed the speed. Setting the state has no
// effect on playback: the player never copies it back to the element.
//
// The state only ever gets a speed the menu lists. The menu ignores a click
// on any of its entries unless one of them is currently marked as chosen, so
// a speed it does not list (the bar goes up to 3×, the menu to 2×) would
// leave it dead until the bar brought the speed back into its range. For
// such a speed the menu is given its nearest entry instead.

const RATE_MIRROR_EVENTS = ["ratechange", "loadedmetadata", "playing"] as const;

/**
 * The mirror runs right after such an event and again a little later: React
 * commits state asynchronously, and while a stream (re)loads the player puts
 * its own value back to 1 at a moment of its choosing.
 */
const RATE_MIRROR_DELAYS_MS = [0, 250, 1500];

/** The part of the player's React context this script relies on (duck-typed). */
interface RateContext {
  playbackRate: number;
  setPlaybackRate(rate: number): unknown;
}

function isRateContext(value: unknown): value is RateContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["playbackRate"] === "number" && typeof candidate["setPlaybackRate"] === "function";
}

/**
 * Walks up React's fiber tree from the <video> to the nearest context
 * provider whose value carries the playback rate. React keeps two copies of
 * every fiber (the current one and the previous render) and the way up may
 * pass through either, so both values are returned.
 */
function findRateContexts(video: Element): RateContext[] {
  const fiberKey = Object.keys(video).find((k) => k.startsWith("__reactFiber$"));
  if (!fiberKey) return [];
  let fiber = (video as unknown as Record<string, unknown>)[fiberKey] as Record<string, unknown> | null;
  for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber["return"] as Record<string, unknown> | null) {
    const found: RateContext[] = [];
    for (const copy of [fiber, fiber["alternate"] as Record<string, unknown> | null]) {
      const props = copy?.["memoizedProps"];
      const value = props && typeof props === "object" ? (props as Record<string, unknown>)["value"] : null;
      if (isRateContext(value)) found.push(value);
    }
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * The speeds the player's menu lists. These are today's; whenever the menu
 * is on screen the list is read from it again (see checkRateMenu), so a
 * change on the site corrects itself the first time the menu is opened.
 */
let listedRates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** How often to look whether the player's speed menu is on screen. */
const RATE_MENU_CHECK_MS = 500;

/** A menu entry such as "1.25x"; the normal speed is written in words instead. */
const RATE_LABEL = /^(\d+(?:[.,]\d+)?)\s*[x×]$/i;

/** The listed speed closest to the real one: the real one itself whenever the menu has it. */
function shownRateFor(rate: number): number {
  return listedRates.reduce((best, listed) => (Math.abs(listed - rate) < Math.abs(best - rate) ? listed : best));
}

/**
 * Reads the speeds from the player's settings dialog while its speed list is
 * on screen: a list whose entries are all speeds like "1.25x", except at
 * most one written in words, which is the normal speed. Recognising the list
 * by its content keeps this independent of the page's class names and ids.
 */
function readListedRates(): number[] | null {
  for (const list of document.querySelectorAll('[role="dialog"] ul')) {
    const labels = [...list.children].map((item) => item.textContent?.trim() ?? "");
    const rates = labels.flatMap((label) => {
      const match = RATE_LABEL.exec(label);
      return match?.[1] ? [Number(match[1].replace(",", "."))] : [];
    });
    if (rates.length < 3 || labels.length - rates.length > 1) continue;
    if (rates.length < labels.length) rates.push(1);
    return [...new Set(rates)].filter((rate) => rate > 0).sort((a, b) => a - b);
  }
  return null;
}

let rateMirrorLogged = false;

function mirrorRate(video: HTMLVideoElement): void {
  if (!video.isConnected) return;
  const rate = video.playbackRate;
  // 0 is the player library holding playback while it buffers, not a speed.
  if (!(rate > 0)) return;

  const contexts = findRateContexts(video);
  if (!rateMirrorLogged && contexts.length > 0) {
    rateMirrorLogged = true;
    console.info(`${LOG_PREFIX} keeping the speed shown in the player's menu in step with the real playback speed`);
  }
  const shown = shownRateFor(rate);
  // If either copy disagrees, the current one may; setting a value the state
  // already has is a no-op for React, so there is no harm in a spare call.
  const stale = contexts.find((context) => context.playbackRate !== shown);
  stale?.setPlaybackRate(shown);
}

/** Learns the menu's speeds while it is on screen and re-mirrors if they differ from the ones assumed. */
function checkRateMenu(): void {
  const rates = readListedRates();
  if (!rates || rates.join() === listedRates.join()) return;
  listedRates = rates;
  console.info(`${LOG_PREFIX} the player's menu lists the speeds ${rates.join(", ")}`);
  for (const video of document.querySelectorAll("video")) mirrorRate(video);
}

/** Mirrors the video's speed now and again a little later (see RATE_MIRROR_DELAYS_MS). */
function scheduleMirror(video: HTMLVideoElement): void {
  for (const delay of RATE_MIRROR_DELAYS_MS) {
    window.setTimeout(() => {
      if (!inCharge()) return;
      try {
        mirrorRate(video);
      } catch (error) {
        if (rateMirrorLogged) return;
        rateMirrorLogged = true;
        console.warn(`${LOG_PREFIX} could not update the speed shown in the player's menu:`, error);
      }
    }, delay);
  }
}

function onRateEvent(event: Event): void {
  if (event.target instanceof HTMLVideoElement && inCharge()) scheduleMirror(event.target);
}

// Media events do not bubble, but a capturing listener on the document sees
// them for every <video>, including players the page creates later.
for (const type of RATE_MIRROR_EVENTS) {
  document.addEventListener(type, onRateEvent, true);
  stoppers.push(() => document.removeEventListener(type, onRateEvent, true));
}

// A copy that starts in a page that is already playing (see "One copy at a
// time") puts right whatever the copy before it left in the menu.
for (const video of document.querySelectorAll("video")) scheduleMirror(video);

const rateMenuTimer = window.setInterval(() => {
  if (!inCharge()) return;
  try {
    checkRateMenu();
  } catch {
    // The list assumed so far stays in use.
  }
}, RATE_MENU_CHECK_MS);
stoppers.push(() => window.clearInterval(rateMenuTimer));

// --- Main ---------------------------------------------------------------------

function search(): void {
  if (!playerClass) {
    const strategies: Array<[string, () => PlayerClass | null]> = [
      ["global shaka object", findViaGlobal],
      ["webpack module registry", findViaWebpack],
      ["Turbopack module registry", findViaTurbopack],
    ];
    for (const [origin, find] of strategies) {
      const cls = find();
      if (!cls) continue;
      playerClass = cls;
      playerClassOrigin = origin;
      installHooks(cls, origin);
      pokeGlobalHelpers();
      break;
    }
    if (!playerClass) return;
  }

  // Instances created after the hooks are in place configure themselves on
  // load; the search below is only for players that predate the hooks, so it
  // runs rarely and only while some <video> has no configured player.
  const pending = [...document.querySelectorAll("video")].filter((video) => !handledVideos.has(video));
  if (pending.length === 0 || Date.now() - lastInstanceSearch < INSTANCE_SEARCH_INTERVAL_MS) return;
  lastInstanceSearch = Date.now();
  pokeGlobalHelpers();
  scanReactFibers(playerClass, pending);
}

let searchErrorLogged = false;

/** One failing pass must never stop the search; the error is logged once. */
function safeSearch(): void {
  if (!inCharge()) return;
  try {
    search();
  } catch (error) {
    if (searchErrorLogged) return;
    searchErrorLogged = true;
    console.warn(`${LOG_PREFIX} search failed:`, error);
  }
}

publish({ active: false, goal: null, wanted: BUFFER_GOAL_SECONDS, how: "looking for the player", version: null });

// Keep looking: the player library and the player itself may load late (on
// video-on-demand pages only after the poster is clicked), and the page may
// create new players as you navigate. Each pass is cheap once the registry
// has been scanned.
safeSearch();
const searchTimer = window.setInterval(safeSearch, SEARCH_INTERVAL_MS);
stoppers.push(() => window.clearInterval(searchTimer));
