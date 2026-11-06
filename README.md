># 🤖 Disclaimer: Entirely vibe coded; use at your own risk

# iVysílání Enhancer

A cross-browser (Firefox + Chrome) extension written in TypeScript that improves the
[iVysílání](https://www.ceskatelevize.cz/) video player of Česká televize. It runs only
on `https://www.ceskatelevize.cz/` and `https://ct24.ceskatelevize.cz/`.

Current features – a floating control bar in the bottom-left corner of the page:

- **Play/Pause button** that controls the player. It works on live streams (e.g.
  `/zive/ct1/`, `ct24.ceskatelevize.cz/#live`) and on video-on-demand pages
  (`/porady/...`). On a video-on-demand page where the player has not been started yet,
  the button starts it; otherwise it toggles play/pause.
- **Playback speed** controls: `−` / `+` change the speed in 0.25× steps (0.25×–3×) and
  clicking the speed label resets it to 1×. The chosen speed survives the player's own
  resets (e.g. the switch from the pre-roll ad to the programme) and navigation between
  episodes.
- **Time to the end / live edge** label: while playing, the bar shows when playback reaches
  the end of the programme at the current speed (`ends 21:47 · 23 min`), or – on a live
  stream above 1× – when it catches up with the live edge (`live in 1:04`). Hovering the
  label spells it out. The estimate ignores ads, and once a live stream reaches the edge
  the player has to wait for the broadcast, so expect it to stall there.

- **Pause budget on live streams**: ČT live streams can be rewound only within a sliding
  window (about 76 s on the plain live stream, 3 h once you have rewound). While paused,
  the bar counts down how long your paused position stays inside that window
  (`resume within 1:23:45`), then shows `position expired`.
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

- **Frame stepping**: the `,` and `.` keys move one frame back / forward, as on YouTube.
  If the video is playing it is paused first. The frame rate is measured from the frames
  the browser decodes (25 fps is assumed until a couple of seconds have played).

The bar is hidden on pages without a player.

Stack: TypeScript, [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill),
[esbuild](https://esbuild.github.io/), Manifest V3.

## Project layout

```
ivysilani-web-extension/
├── build.mjs            # esbuild script (bundle + copy manifest into dist/)
├── package.json
├── tsconfig.json
├── src/
│   ├── manifest.json    # extension manifest (copied to dist/ as-is)
│   ├── content.ts       # content script (isolated world): the control bar
│   └── page.ts          # content script (page world): raises the player's buffer
└── dist/                # build output – this is what you load into the browser
```

## Setup

```bash
npm install
npm run build        # one-off build into dist/
npm run watch        # rebuild on every change
npm run typecheck    # run tsc without emitting (esbuild does not type-check)
```

## Load it in a browser

### Firefox

Easiest: `npm run firefox`. This builds and uses Mozilla's `web-ext` tool to open a
fresh Firefox profile with the extension loaded; it reloads when `dist/` changes.

Manually: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
pick `dist/manifest.json`.

> Firefox treats Manifest V3 host permissions as optional. If the control bar doesn't show
> up, click the puzzle-piece **Extensions** button in the toolbar, find the extension,
> and allow it on the site (or "Always allow on ceskatelevize.cz").

### Chrome / Edge / Brave

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
choose the `dist/` folder. After each rebuild, click the reload icon on the
extension's card.

Chrome ignores the `browser_specific_settings` key (it's Firefox-only) – you may see a
harmless warning about it on the extensions page.

## Notes on the manifest

- `content_scripts[].matches` and `host_permissions` are limited to
  `https://www.ceskatelevize.cz/*` and `https://ct24.ceskatelevize.cz/*`, so the extension
  never runs anywhere else.
- `browser_specific_settings.gecko.id` gives the extension a stable ID in Firefox
  (needed for signing and for APIs like `storage.sync`). Change it to something of your
  own before publishing.
- `browser_specific_settings.gecko.data_collection_permissions` is required by Firefox
  for new extensions. `{"required": ["none"]}` declares that the extension collects no
  data. Because this key only exists since Firefox 142, `strict_min_version` is set to
  `142.0`; the manifest passes `web-ext lint` with zero warnings.

## How it works

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
- Frame stepping measures the frame rate from the decoded-frame counter
  (`getVideoPlaybackQuality().totalVideoFrames`) over two seconds of playback, snapped to a
  common rate; it counts every frame however rarely a throttled tab paints. Frames sit on a
  regular grid, so any media time reported by `requestVideoFrameCallback` – even a stale one –
  fixes the grid's phase, and a step seeks to the middle of the neighbouring frame on that
  grid, which cannot land on a boundary. Key presses in text fields or with modifiers are
  ignored.
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
  re-attaches the controls to whichever player is currently on the page.
- `src/page.ts` is a second content script declared with `"world": "MAIN"`, so it runs in
  the page's own JavaScript world (Chrome, and Firefox since 128) where the player library
  lives. It locates the player class without depending on one page build: first a global
  `shaka` object, then the webpack chunk registry (`self.webpackChunk*`, used by
  www.ceskatelevize.cz), then the Turbopack chunk registry (`self.TURBOPACK`, used by
  ct24.ceskatelevize.cz). Both registries accept a probe chunk that hands the script the
  bundler's require function and module tables, from which it recognises the player module
  by its source. It
  then hooks the class: every instance gets `streaming.bufferingGoal = 120` on each
  `load()`, the setting is re-asserted if the page's own `configure()` call touches it,
  and instances that existed before the hooks are found through the page's debugging
  helpers (`window.shakaUtils`) or React's fiber tree. The outcome is written to a data
  attribute on `<html>` (read by the bar's buffer label) and logged with the prefix
  `[ivysilani-web-extension/page]`. If none of this finds a player, the bar's tooltip says
  so instead of anything breaking.
- esbuild bundles each script (and, for `content.ts`, the polyfill) into `dist/` in IIFE
  format (content scripts can't be ES modules) and copies the manifest next to it.

## Next steps

Typical additions: a background script (`background.scripts` in Firefox,
`background.service_worker` in Chrome), a popup (`action.default_popup`), or an options
page – each is just another entry point in `build.mjs` plus a manifest entry.
