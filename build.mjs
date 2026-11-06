// Build script: bundles the TypeScript sources with esbuild and copies the
// manifest into dist/. Run `node build.mjs` for a one-off build or
// `node build.mjs --watch` to rebuild on every change.

import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

// Copies the static files (manifest, icons, ...) into dist/ on every build.
const copyStaticFiles = {
  name: "copy-static-files",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      cpSync("src/manifest.json", `${outdir}/manifest.json`);
    });
  },
};

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ["src/content.ts"],
  outdir,
  bundle: true,
  // Content scripts must be plain scripts (no ES modules), so wrap in an IIFE.
  format: "iife",
  target: ["chrome120", "firefox120"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  plugins: [copyStaticFiles],
});

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
