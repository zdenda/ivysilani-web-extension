># 🤖 Disclaimer: Entirely vibe coded; use at your own risk

# Hello World Extension

A minimal cross-browser (Firefox + Chrome) extension written in TypeScript. It adds a
small "Hello World" badge to the bottom-left corner of every page.

Stack: TypeScript, [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill),
[esbuild](https://esbuild.github.io/), Manifest V3.

## Project layout

```
hello-world-extension/
├── build.mjs            # esbuild script (bundle + copy manifest into dist/)
├── package.json
├── tsconfig.json
├── src/
│   ├── manifest.json    # extension manifest (copied to dist/ as-is)
│   └── content.ts       # content script that injects the badge
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

> Firefox treats Manifest V3 host permissions as optional. If the badge doesn't show
> up, click the puzzle-piece **Extensions** button in the toolbar, find the extension,
> and allow it on the site (or "Always allow on all sites").

### Chrome / Edge / Brave

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
choose the `dist/` folder. After each rebuild, click the reload icon on the
extension's card.

Chrome ignores the `browser_specific_settings` key (it's Firefox-only) – you may see a
harmless warning about it on the extensions page.

## Notes on the manifest

- `browser_specific_settings.gecko.id` gives the extension a stable ID in Firefox
  (needed for signing and for APIs like `storage.sync`). Change it to something of your
  own before publishing.
- `browser_specific_settings.gecko.data_collection_permissions` is required by Firefox
  for new extensions. `{"required": ["none"]}` declares that the extension collects no
  data. Because this key only exists since Firefox 142, `strict_min_version` is set to
  `142.0`; the manifest passes `web-ext lint` with zero warnings.

## How it works

- `src/content.ts` is declared as a content script in `src/manifest.json` with
  `"matches": ["<all_urls>"]`, so it runs on every http(s) page once the DOM is ready.
- It imports `browser` from `webextension-polyfill`, which is the native `browser.*`
  API in Firefox and a promise-based wrapper around `chrome.*` in Chrome. The script
  uses `browser.runtime.getManifest()` to put the extension name/version in the badge's
  tooltip.
- esbuild bundles the script and the polyfill into a single `dist/content.js` in IIFE
  format (content scripts can't be ES modules) and copies the manifest next to it.

## Next steps

Typical additions: a background script (`background.scripts` in Firefox,
`background.service_worker` in Chrome), a popup (`action.default_popup`), or an options
page – each is just another entry point in `build.mjs` plus a manifest entry.
