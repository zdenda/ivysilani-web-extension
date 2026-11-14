# Guide for AI coding agents

This repository is a small browser extension (TypeScript, esbuild, Manifest V3) that
improves the video player of Česká televize. Read these before changing anything:

- `README.md`, section "How it works": why the code looks the way it does.
- `docs/development-notes.md`: how to test against the real player, what is known about
  the player, and the traps.

## Layout

- `src/content.ts`: content script in the isolated world. The control bar, the keys,
  speed, seeking and pausing on live streams.
- `src/page.ts`: content script in the page's own world (`"world": "MAIN"`). The buffer
  setting, the player's speed menu, and the hand-over between copies of itself.
- `src/manifest.json`: copied into the package as it is.
- `.github/workflows/`: Build for every commit and pull request, Release for every
  `v*` tag.

## Commands

```bash
npm ci
npm run check      # version numbers, typecheck, web-ext lint with warnings as errors
npm run package    # build and pack web-ext-artifacts/enhancer-for-ivysilani-<version>.xpi
npm run firefox    # a fresh Firefox profile with the extension, reloading on rebuild
```

`npm run check` and `npm run package` must pass before a change is offered for commit.
There are no automated tests; say what was verified on the live sites and what was not.

## Working agreements

- **One feature per commit**, with a message that names the feature and explains why.
- **Commit only when the owner asks**, after the change has been verified.
- **Never rewrite published history.** Everything on `origin/main` is public. Fixes to
  released features are new commits.
- **Ask where finished work goes.** When a change is done and verified, ask the owner
  whether to commit it straight to `main` or to open a pull request. Not everything
  needs a pull request.
- **Pull requests are merged by rebase**, never with a merge commit or a squash, so that
  `main` stays a straight line of one commit per feature.
- **Pushing, tagging and releasing need the owner's go-ahead** each time. Pushing a tag
  like `v1.2.3` publishes a release by itself.
- **Anything an agent posts to GitHub says so.** Issues and pull requests created by an
  agent end with a note that an AI agent wrote them and whether the content was tested
  or only read from the code. Check for an existing issue before opening a new one.
- **Verify on the real sites.** ČT24 live is the page the owner uses most. Conclusions
  drawn from reading the player's code have been wrong more than once, so check them on
  the live page before building on them.

## Things that are easy to get wrong

- `content.ts` cannot see properties the page's JavaScript puts on DOM nodes. Anything
  that needs React's data belongs in `page.ts`.
- `page.ts` must never be able to break the site. It probes the bundler only after the
  bundler's runtime has started, and it catches its own errors.
- Rebuilding while `npm run firefox` runs reloads the extension in the owner's browser.
- The add-on ID in the manifest is permanent.
