// Page-world script for www.ceskatelevize.cz and ct24.ceskatelevize.cz.
//
// Runs in the page's own JavaScript world (manifest `"world": "MAIN"`), not in
// the isolated content-script world, because the video player library lives
// in the page's module scope. Its single job: ask the player to buffer further
// ahead than its default 10 s, so that short network outages pass unnoticed.
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
    applyTo(this, `${how}; on stream load`);
    return originalLoad.apply(this, args);
  };

  proto.configure = function (this: PlayerLike, config: unknown, value?: unknown): unknown {
    const result = originalConfigure.call(this, config, value);
    if (!applying && touchesBufferingGoal(config, value)) applyTo(this, `${how}; re-asserted after the page reconfigured it`);
    return result;
  };

  proto.getConfiguration = function (this: PlayerLike) {
    noteInstance(this, `${how}; existing instance`);
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

const TURBOPACK_PROBE_CHUNK = "ivysilani-ext-probe.js";
const TURBOPACK_PROBE_MODULE = "ivysilani-ext-probe";
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
window.setInterval(safeSearch, SEARCH_INTERVAL_MS);
