# Development notes

What was learned while building version 1.0.0 and is not obvious from the code. The
design itself is explained in the README under "How it works"; this file covers how to
test changes, what is known about ČT's player, and the traps that cost time.

Everything here describes the sites as they were in November 2026.

## Testing against the real player

There are no automated tests. Every feature was verified on the live sites, and ČT24
live (`https://ct24.ceskatelevize.cz/#live`) is the page that matters most.

### In the installed extension

`npm run firefox` opens a fresh Firefox profile with the extension loaded and reloads it
whenever `dist/` changes.

- **A reload leaves old code in open tabs.** Firefox runs the new content scripts in
  tabs that are already open. The old copy of `content.ts` dies with the old extension,
  but `page.ts` runs in the page's own world and stays alive. Since 1.0.0 an older copy
  of `page.ts` retires itself when a newer one starts, but a page reload is still the
  only clean start. A bug that shows up "sometimes" right after a rebuild is often two
  builds in one page.
- **Every `npm run build` or `npm run package` triggers that reload** in a running
  `npm run firefox` session. Changing the add-on ID in the manifest while it runs can
  leave two copies of the extension in that profile; restart it.
- The packaged `.xpi` installs permanently only in Firefox Nightly and Developer
  Edition with `xpinstall.signatures.required` set to `false`.

### Without installing: injecting the bundles into a page

Useful when a browser is driven by a script or by an AI agent that cannot install
extensions.

1. Bundle each script as an IIFE, for example
   `npx esbuild src/content.ts --bundle --format=iife --minify --alias:webextension-polyfill=<stub>`,
   where the stub exports `runtime.getManifest()`. `src/page.ts` needs no stub.
2. Reload the page, then evaluate the page bundle first and the content bundle second.
   Always reload before injecting again; leftover bars and listeners spoil the results.
   Going to the same `#live` URL does not reload the page.
3. Wrap `console.info` and `console.warn` first to collect the lines that start with
   `[ivysilani-web-extension`.

What this kind of test cannot show:

- **Both bundles run in the page's world.** In the real extension `content.ts` runs in
  the isolated world, where the properties the page's JavaScript puts on DOM nodes
  (React's `__reactProps$…` and `__reactFiber$…`) are invisible. Code in `content.ts`
  that reads them passes this test and fails when installed. To mimic the isolated
  world, wrap `Object.keys` before injecting so that it drops `__react*` keys for
  `Element` arguments.
- **`page.ts` starts late.** In the real extension it starts at `document_start`, before
  the bundler's runtime. To test that case, swap the registry global (`TURBOPACK` on
  ct24, `webpackChunk_N_E` on www) for a plain `[]` before injecting, then put the real
  one back.
- **An extension reload** can be simulated by injecting the page bundle a second time.

Practical details:

- **Cookie dialog.** It blocks the pre-roll spot on archive pages until it is answered.
- **Hidden pages.** The site pauses the pre-roll spot while the document is hidden. On
  ČT24 the live video starts muted, and in a Chromium page that is really hidden it was
  paused again within a fraction of a second of every `play`, even with
  `document.hidden` overridden for the page's JavaScript. Setting `video.volume = 0`
  and then `video.muted = false` kept it playing silently.
- **Timers** in a hidden page fire about once a second, so short waits take longer.
- **Trusted input matters.** The fix for play and pause during a stream switch reacts
  only to real clicks and key presses (`event.isTrusted`). Events dispatched from script
  do not count, which is also why the extension's own slider click is ignored there.
- **A precise content clock.** The app's player wrapper has `getPlayheadTimeAsDate()`,
  which returns the wall-clock time of the picture and is the same on the plain live
  stream and the time-shift stream. Find the object by walking React fibers up from the
  `<video>`. Estimates from `seekable.end` jump in whole 3.84 s segments.
- **The player's own buttons** exist only while its controls are shown. A `mousemove` on
  the overlay that covers the picture shows them for 2 s; while paused they stay.

## What is known about the player

- **Library and bundlers.** shaka-player 4.16 on both sites, bundled with webpack on
  `www.ceskatelevize.cz` and with Turbopack on `ct24.ceskatelevize.cz`. The page is a
  React 18 app, and the `<video>` sits directly in `.playerPageWrapper`.
- **Controls.** The overlay that reacts to the mouse is a sibling of the `<video>`, not
  an ancestor. The controls contain two `[role="slider"]` elements, the timeline and the
  volume control.
- **Two live streams.** The plain live stream keeps about 75 s. The time-shift stream
  keeps 3 hours (a seekable span of about 10 793 s) and is loaded only by a click on the
  timeline at 98 % or less. After such a click the player loads the stream at the start
  of its window, seeks to the live edge, then to the clicked position. These steps can
  be more than 700 ms apart.
- **Events during a stream switch.** The `<video>` fires `emptied` and `loadstart`
  twice, then `loadedmetadata`. It becomes paused without a `pause` event. If it was
  playing, the player calls `play()` about two seconds later. In the tests it did not
  start playing by itself when it had been paused.
- **A long pause ends on the plain live stream.** After pauses of 46, 55 and 82 minutes on
  the time-shift stream the player reloaded the stream by itself (`emptied` and
  `loadstart` twice, as in a stream switch) and resumed on the plain live stream, a few
  seconds behind live. The two streams count time differently (about 11 000 s on one,
  about 70 000 s on the other at the same moment), so a position remembered on one
  means nothing on the other; only the distance behind live carries over. Whether the
  reload happens during the pause or at the press of play is not known.
- **The player's keys.** Its own arrow keys seek 10 s. They also worked with the focus
  outside the player and with Shift held. On the plain live stream that seek is clamped
  about 67 s behind live.
- **Speed.** The speed shown in the settings menu is React state (`playbackRate` and
  `setPlaybackRate` in a context about ten fibers above the `<video>`), separate from
  the element's real rate. The menu lists 0.25 to 2 and ignores a click on any entry
  unless one entry is marked as chosen. Live streams have no speed entry. The player
  library sets the rate to 1 just before it unloads a stream and to 0 while it buffers.
- **Archive pages.** The `<video>` appears only after the poster's play button is
  clicked. A pre-roll spot plays first in the same `<video>` element, then the programme.

## What was measured

- A rewind past the live window, or a pause moved to the time-shift stream, lands
  within one 3.84 s segment of the exact point and errs on the early side.
- Pauses of 20 s and of 10 min resumed at the paused position in tests. The owner
  confirmed a longer pause by hand.
- A pause of 82 minutes on ČT1 live, 32 minutes behind live, resumed 6849 s behind live
  where 6846 s was expected, after the extension switched back to the time-shift stream.
  A pause of 46 minutes on ČT24 live, 16 minutes behind live, resumed 3699 s behind live
  where 3697 s was expected. The owner ran both tests; the numbers are from the console
  logs.
- On a page without a player, `page.ts` scans the bundler's modules once (5 to 9 ms for
  about 700 to 850 modules) and then costs about 0.2 ms per half-second tick. These
  numbers come from a code audit made before 1.0.0.
- A build on Linux in CI and a build on Windows produce the same three files, byte for
  byte.

## What has not been tested

- The extension installed in Chrome, Edge or Brave.
- The Release workflow. It runs only for a new version tag, so its first run is the
  first release after 1.0.0.

## Traps

- **Checking for Windows line endings.** In Git Bash on Windows, `grep -c $'\r'` gave
  wrong counts. Use `git ls-files --eol`, or count the bytes with a small script.
- **Published history.** Everything up to the tag `v1.0.0` is public. A fix to a released
  feature is a new commit, not an amended one.
- **A version tag is a release.** Pushing a tag like `v1.2.3` publishes a GitHub release
  through the Release workflow.
