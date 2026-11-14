># 🤖 Disclaimer: Entirely vibe coded; use at your own risk

# Enhancer for iVysílání

An unofficial browser extension that improves the
[iVysílání](https://www.ceskatelevize.cz/) video player of Česká televize. It is not
affiliated with or endorsed by Česká televize. It runs only on
`https://www.ceskatelevize.cz/` and `https://ct24.ceskatelevize.cz/`, collects nothing
and sends nothing anywhere.

It is written for Firefox. The same build is meant to load in Chrome, Edge and Brave too,
but it has never been tested installed there.

What it adds – a floating control bar in the bottom-left corner of the page:

- **Play/Pause button** that controls the player. It works on live streams (e.g.
  `/zive/ct1/`, `ct24.ceskatelevize.cz/#live`) and on video-on-demand pages
  (`/porady/...`). On a video-on-demand page where the player has not been started yet,
  the button starts it; otherwise it toggles play/pause.
- **Playback speed** controls: `−` / `+` change the speed in 0.25× steps (0.25×–3×) and
  clicking the speed label resets it to 1×. The chosen speed survives the player's own
  resets (e.g. the switch from the pre-roll ad to the programme) and navigation between
  episodes. The bar and the player's own speed setting (*Nastavení → Rychlost přehrávání*
  on archive videos) show the same value: a speed set in either place appears in both. The
  player's menu only knows 0.25×–2×, so for the bar's faster speeds it shows 2×, its
  nearest entry, and stays usable.
- **Time to the end / live edge** label: while playing, the bar shows when playback reaches
  the end of the programme at the current speed (`ends 21:47 · 23 min`), or – on a live
  stream above 1× – when it catches up with the live edge (`live in 1:04`). Hovering the
  label spells it out. The estimate ignores ads, and once a live stream reaches the edge
  the player has to wait for the broadcast, so expect it to stall there.

- **Pauses that survive on live streams**: ČT live streams can be rewound only within a
  sliding window (about 76 s on the plain live stream, 3 h once you have rewound), so on
  the plain stream a pause of more than a minute loses its position. A pause longer than
  3 s on the plain stream therefore moves the paused position to the 3 h time-shift stream
  (the same slider trick as above), after which a resume lands exactly where you paused for
  up to about 3 hours. While paused, the bar counts down how long the position stays inside
  the window (`resume within 2:58:27`), then shows `position expired`.
- **Resume guard on live streams**: the player remembers where you paused and seeks back
  there on resume, but if that position has left the window it clamps to the oldest
  available point, and sometimes it ends up at live. If the player lands well ahead of
  the paused position although an older one is still available, the extension seeks
  back to the paused position (or to the oldest available point). Resuming through the
  player's own "ŽIVĚ" button is left alone. Every pause/resume on a live stream is logged
  to the browser console (prefix `[ivysilani-web-extension]`) so that a bad resume can
  be diagnosed.

- **Bigger buffer**: the player buffers only 10 s ahead by default, so a short Wi-Fi outage
  stalls playback. The extension asks it to buffer 120 s ahead instead (like YouTube). The
  bar shows `buffer 118 s` – the seconds actually buffered ahead of the playhead – and its
  tooltip says whether the setting is active and how the player was reached. Note that the
  buffer can only hold what already exists: at the live edge there is nothing ahead to
  fetch, so this helps time-shifted and on-demand playback, not watching live at the edge.

- **Seeking that works on live streams**: `« 10 s` / `10 s »` buttons, the `J` / `L` keys
  (10 s) and `←` / `→` (5 s), as on YouTube. The player's own skip button and arrow keys
  seek 10 s but are silently clamped about 67 s behind live, because the plain live stream
  keeps only ~75 s and only the (coarse, ~20 s per pixel) slider loads the 3 h time-shift
  stream. The extension seeks the video directly inside the window and, for a rewind that
  would leave it, clicks the player's slider from script to switch streams, then seeks to
  the exact point; the paused state is preserved.
- **Frame stepping**: the `,` and `.` keys move one frame back / forward, as on YouTube.
  If the video is playing it is paused first. The frame rate is measured from the frames
  the browser decodes (25 fps is assumed until a couple of seconds have played).

The bar is hidden on pages without a player.

## Install

Each [release](https://github.com/zdenda/ivysilani-web-extension/releases) has the
packaged extension attached as an `.xpi` file. Mozilla has not signed it, and that
decides where it can be installed:

- **Firefox Nightly or Developer Edition, permanently.** Open `about:config` and set
  `xpinstall.signatures.required` to `false`. Then open `about:addons`, click the gear
  icon, choose **Install Add-on From File…** and pick the downloaded `.xpi`.
- **Regular Firefox, until the browser restarts.** Release and beta versions of Firefox
  refuse unsigned extensions. Open `about:debugging#/runtime/this-firefox`, click
  **Load Temporary Add-on…** and pick the `.xpi`.
- **Chrome, Edge, Brave.** Build the extension from source (see below), open
  `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose
  the `dist/` folder. This has never been tested.

> Firefox treats Manifest V3 host permissions as optional. If the control bar doesn't show
> up, click the puzzle-piece **Extensions** button in the toolbar, find the extension,
> and allow it on the site (or "Always allow on ceskatelevize.cz").

## Privacy

The extension makes no network requests, stores nothing, and reads nothing beyond the
player on the two ČT sites. Its manifest declares to Firefox that it collects no data.
What it does is logged to the page's browser console with the prefix
`[ivysilani-web-extension]`.

## Known limits

- The bar's seek buttons, keys and speed also work on the pre-roll spot that plays
  before a programme.
- It works only on `www.ceskatelevize.cz` and `ct24.ceskatelevize.cz`, not on other ČT
  sites and not on players embedded elsewhere.
- It depends on how ČT's player is built today. When the player changes, parts of the
  extension may stop working until it is updated.
- The bar sits in the bottom-left corner of the window. Where the player reaches the
  bottom of the window, the bar can cover the player's own buttons in that corner.
- The keys (`J`, `L`, the arrow keys, `,` and `.`) are taken on the whole page whenever a
  player is present, except while typing in a field. There is no switch to turn them off.
- The bar is not shown in fullscreen.
- The interface is in English only.
- The 120 s buffer makes the player download further ahead, which uses more data on a
  metered connection.

## Licence

© 2026 Zdeněk Kořán. All rights reserved. You may install and use the extension for
personal use.

## Build from source

Stack: TypeScript, [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill),
[esbuild](https://esbuild.github.io/), Manifest V3.

```
ivysilani-web-extension/
├── .github/workflows/   # GitHub Actions: build every commit, publish tagged releases
├── CLAUDE.md            # guide for AI coding agents
├── docs/
│   └── development-notes.md  # testing against the real player, player facts, traps
├── build.mjs            # esbuild script (bundle + copy manifest into dist/)
├── package.json
├── tsconfig.json
├── scripts/
│   └── check-version.mjs  # manifest, package.json and release tag must agree
├── src/
│   ├── manifest.json    # extension manifest (copied to dist/ as-is)
│   ├── content.ts       # content script (isolated world): the control bar
│   └── page.ts          # content script (page world): buffer size, the player's speed menu
├── dist/                # build output – this is what you load into the browser
└── web-ext-artifacts/   # the packaged .xpi
```

```bash
npm ci
npm run build        # one-off build into dist/
npm run watch        # rebuild on every change
npm run typecheck    # run tsc without emitting (esbuild does not type-check)
npm run check        # version numbers, typecheck and web-ext lint, as CI runs them
npm run package      # build and pack web-ext-artifacts/enhancer-for-ivysilani-<version>.xpi
```

### Builds and releases on GitHub

Two GitHub Actions workflows live in `.github/workflows/`:

- **Build** runs for every commit pushed to `main` and for every pull request. It runs
  `npm run check` and `npm run package` and keeps the `.xpi` with the run: open the run
  under the repository's *Actions* tab and download it from the *Artifacts* section.
  GitHub asks for a login there and deletes artifacts after 90 days.
- **Release** runs for every tag of the form `v1.2.3`. It builds the tagged commit the
  same way, refuses to go on if the tag does not name the version in the manifest, and
  publishes a GitHub release with the `.xpi` attached. The release text lists the titles
  of the commits since the previous tag and can be edited on GitHub afterwards.

To release a new version:

1. Set `version` in `src/manifest.json`.
2. Run `npm version <version> --no-git-tag-version`, which sets the same version in
   `package.json` and `package-lock.json`.
3. Commit, then tag the commit: `git tag -a v<version> -m "Version <version>"`.
4. Push both: `git push origin main v<version>`.

### Develop in Firefox

Easiest: `npm run firefox`. This builds and uses Mozilla's `web-ext` tool to open a
fresh Firefox profile with the extension loaded; it reloads when `dist/` changes.
Firefox then also runs the new build in the tabs that are already open. The older
copy steps aside (see "How it works"), but what the bar remembered, such as the chosen
speed, starts afresh, and a page reload is still the cleanest start for a test.

Manually: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
pick `dist/manifest.json`.

### Develop in Chrome / Edge / Brave

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
choose the `dist/` folder. After each rebuild, click the reload icon on the
extension's card.

Chrome ignores the `browser_specific_settings` key (it's Firefox-only) – you may see a
harmless warning about it on the extensions page.

## Notes on the manifest

- `content_scripts[].matches` and `host_permissions` are limited to
  `https://www.ceskatelevize.cz/*` and `https://ct24.ceskatelevize.cz/*`, so the extension
  never runs anywhere else.
- `browser_specific_settings.gecko.id` gives the extension a stable ID in Firefox. It
  must stay the same in every later version, signed or not.
- `browser_specific_settings.gecko.data_collection_permissions` is required by Firefox
  for new extensions. `{"required": ["none"]}` declares that the extension collects no
  data. Firefox supports this key from version 140 on desktop and 142 on Android, so
  `strict_min_version` is set to `142.0`; the manifest passes `web-ext lint` with zero
  warnings.
- `minimum_chrome_version` is `120`, the version the build targets.

## How it works

How to test a change against the real player, what is known about the player, and the
traps met so far are in [docs/development-notes.md](docs/development-notes.md).
[CLAUDE.md](CLAUDE.md) is the short guide for AI coding agents working on this repository.

- `src/content.ts` is declared as a content script in `src/manifest.json`, so it runs on
  every page of the two domains once the DOM is ready.
- The iVysílání player renders an ordinary `<video>` element straight into the page
  (inside `.playerPageWrapper`; no iframe, no shadow DOM), so the controls drive it
  through the standard `HTMLMediaElement` API (`play()` / `pause()` / `playbackRate`)
  and follow its state via the `play` / `pause` / `ratechange` events.
- The player silently resets `playbackRate` to 1 when it swaps the source inside the same
  `<video>` element (pre-roll ad → programme). The script remembers the speed you chose
  and re-applies it on `loadedmetadata` / `playing`, and whenever it attaches to a new
  `<video>` element. At 1× it leaves the player alone.
- The player keeps the speed it *shows* in its settings menu in React state (a context
  value with `playbackRate` / `setPlaybackRate`), separate from the `<video>` element's real
  rate: its menu sets both, the bar only the element. Two small rules keep them together.
  `src/page.ts` copies the element's rate into that state after every `ratechange`,
  `loadedmetadata` and `playing` (the player also puts its own value back to 1 on each
  reload), so the menu always shows the real speed; the state is found by walking React's
  fiber tree up from the `<video>`, and setting it never touches playback. The state only
  ever gets a speed the menu lists: the menu ignores a click on its entries unless one of
  them is marked as chosen, so a speed outside its list would leave it dead. For such a
  speed it gets the nearest listed one. The list is today's (0.25×–2×) and is read again
  from the menu whenever its speed list is on screen, recognised by its labels ("1.25x"),
  so a change on the site corrects itself the first time the menu is opened. `src/content.ts`
  adopts any speed it did not set itself as "the speed you chose", so a pick in the
  player's menu is what the bar steps from and what gets re-applied later. The one
  ambiguous value is 1×: it is what *Normální* in the menu sets, and also what the browser
  and the player library put back when a stream is reloaded or the player is torn down
  (the library does so a moment *before* the reload becomes visible). So 1× during a
  reload is the reset that gets undone, and 1× outside one counts as a choice only once
  it has lasted 2 s with no reload and no new player. A rate of 0 (the player library
  holding playback while it buffers) is ignored by both scripts.
- The ETA label is computed from the `<video>` element alone and refreshed on every
  `timeupdate`. Video on demand: `(duration − currentTime) / playbackRate`. Live streams
  report `duration === Infinity`; their live edge is the end of `video.seekable`, the
  player normally sits about a minute behind it, and every second of playback at rate
  `r` closes that gap by `r − 1` seconds, so the countdown is `gap / (r − 1)`.
- The time-shift window length is measured while playing as
  `seekable.end − seekable.start`. `seekable.start` is the lower of shaka-player's window
  start and the start of the back-buffer, so it is only trusted when the buffer starts
  later; during a pause it is frozen by the back-buffer, which is why the window start is
  derived from the live edge (`seekable.end − window`) instead. The pause budget is
  `pausedPosition − 5 s − windowStart` (5 s is shaka's `safeSeekOffset`, where it lands
  when the playhead is outside the window).
- Seeking on a live stream: a forward seek is capped 3 s before the live edge; a backward
  seek whose target is above `windowStart + 5 s + 1 s` is applied to the `<video>` directly
  (shaka clamps anything below `windowStart + safeSeekOffset`). Otherwise the script makes
  the player render its controls (they are not in the DOM while hidden): it sends a
  synthetic `mousemove` to the overlay that covers the picture, which is a sibling of the
  `<video>` and is found by hit-testing the middle of the picture, because a content script
  cannot see the page's React props; if the player is scrolled out of view, every leaf
  element of the player gets the event instead. Then it clicks
  the timeline (of the player's sliders the widest; the volume control is one too) at
  `1 − max(behind + 120 s, 250 s) / 3 h` with synthetic pointer and mouse
  events (the player rounds the slider to whole percent and treats 99 % as "still live", so
  a request must land at 98 % or less). The events go to the part of the timeline under
  that point, looked up by position when something else lies on top of it, so that
  nothing but the timeline ever receives the click. Once the time-shift stream (seekable
  span > 1000 s) has settled, the script seeks to
  `seekable.end − behind` and restores the paused or playing state. If the user plays or
  pauses while the switch is under way (a `play` or `pause` event within a second of a
  real click or key press made after the switch began), that is the state it ends in;
  the player's own `play()` after the reload follows no such gesture. `behind` is anchored to
  wall-clock time (it grows while the switch takes its few seconds), and the live edge is
  tracked against wall-clock time too, because the player moves `seekable.end` in whole
  3.84 s segments. "Seconds behind live" is the
  same quantity on both streams, which is what makes the precise seek possible (measured
  with the player's own content clock, the landing is within one 3.84 s segment of the
  exact point on both ČT24 and ČT1, and a miss lands early, so nothing is skipped). A pause on
  the plain stream that lasts 3 s schedules the same switch with the paused position, so
  the time-shift stream's 3 h window, not the plain stream's 75 s, decides how long a pause
  may last. The player's own seek to the slider position normally comes before the precise
  seek, but under load it can arrive after it and undo it. For 8 s after the precise seek
  the script therefore follows the playhead, and a `seeked` that leaves it somewhere
  playback could not have reached is undone (at most twice). A key press, a click or a
  pointer press in the player, or the bar's own seek buttons disarm this, so a deliberate
  seek is never fought.
- Frame stepping measures the frame rate from the decoded-frame counter
  (`getVideoPlaybackQuality().totalVideoFrames`) over two seconds of playback, snapped to a
  common rate; it counts every frame however rarely a throttled tab paints. Frames sit on a
  regular grid, so any media time reported by `requestVideoFrameCallback` – even a stale one –
  fixes the grid's phase, and a step seeks to the middle of the neighbouring frame on that
  grid, which cannot land on a boundary. Key presses in text fields (also inside a shadow
  tree) or with Ctrl, Alt or Meta are ignored, and so is Shift with an arrow key, which
  extends a text selection.
- The resume guard is armed on the `play` event after a pause and checks every `playing`
  and `seeked` event for the next 10 s, because the player settles in steps (seek to the
  remembered position, then clamp to the window, sometimes a stream reload). The expected
  position is `max(pausedPosition, windowStart + 5 s)`; if the playhead is more than 10 s
  past it, the script seeks back once. A click on the player's "ŽIVĚ" button while paused
  is honoured, and any other click in the player or key press after the resume disarms the
  guard so it never undoes a deliberate seek.
- Both sites are single-page apps and the `<video>` element appears and disappears as
  you navigate (on video-on-demand pages it is only created after the poster's
  "Přehrát video" button is clicked). A `MutationObserver` watches the DOM and
  re-attaches the controls to whichever player is currently on the page. A paused
  position, a pending resume or a pending stream switch is dropped when the page path
  changes, so that it cannot act on the next channel.
- `src/page.ts` is a second content script declared with `"world": "MAIN"`, so it runs in
  the page's own JavaScript world (Chrome, and Firefox since 128) where the player library
  lives. It locates the player class without depending on one page build: first a global
  `shaka` object, then the webpack chunk registry (`self.webpackChunk*`, used by
  www.ceskatelevize.cz), then the Turbopack chunk registry (`self.TURBOPACK`, used by
  ct24.ceskatelevize.cz). Both registries accept a probe chunk that hands the script the
  bundler's require function and module tables, from which it recognises the player module
  by its source. A probe is pushed only once the bundler's runtime has replaced the
  registry's `push` with its own function. Before that the registry is a plain array in
  which chunks queue up for the runtime to work through while the page loads, and a probe
  in that queue could stop the page from loading if the site ever changed the registry
  format; pushed afterwards, it is handled inside the script's own call, where a failure
  only ends the search. It
  then hooks the class: every instance gets `streaming.bufferingGoal = 120` on each
  `load()`, the setting is re-asserted if the page's own `configure()` call touches it,
  and instances that existed before the hooks are found through the page's debugging
  helpers (`window.shakaUtils`) or React's fiber tree. The outcome is written to a data
  attribute on `<html>` (read by the bar's buffer label) and logged with the prefix
  `[ivysilani-web-extension/page]`. If none of this finds a player, the bar's tooltip says
  so instead of anything breaking.
- When the extension is reloaded or updated, Firefox runs both content scripts again in
  the tabs that are already open (Chrome waits for the page to be reloaded). The old
  copy of `content.ts` dies with the old extension and leaves only its bar behind, which
  the new copy removes. `page.ts` is different: it lives in the page's own world, where
  nothing removes its timers, listeners and hooks, so the old and the new version would
  both act on one player and undo each other's work (the player's speed menu going
  blank at random was how this first showed). Every copy therefore announces itself
  under a shared `Symbol.for` key on `window`, and a copy that finds a later
  announcement stops: it clears its timers and listeners, and its hooks on the player
  class pass every call through. The copy that takes over hooks the class again, finds
  the running player and puts the menu's speed right at once. Its Turbopack probe is
  named after the copy, because that runtime runs a module only once.
- esbuild bundles each script (and, for `content.ts`, the polyfill) into `dist/` in IIFE
  format (content scripts can't be ES modules) and copies the manifest next to it.
