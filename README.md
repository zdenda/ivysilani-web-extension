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
│   └── content.ts       # content script that injects the control bar
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
- Both sites are single-page apps and the `<video>` element appears and disappears as
  you navigate (on video-on-demand pages it is only created after the poster's
  "Přehrát video" button is clicked). A `MutationObserver` watches the DOM and
  re-attaches the controls to whichever player is currently on the page.
- esbuild bundles the script and the polyfill into a single `dist/content.js` in IIFE
  format (content scripts can't be ES modules) and copies the manifest next to it.

## Next steps

Typical additions: a background script (`background.scripts` in Firefox,
`background.service_worker` in Chrome), a popup (`action.default_popup`), or an options
page – each is just another entry point in `build.mjs` plus a manifest entry.
