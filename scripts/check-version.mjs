// Fails when the version numbers disagree. src/manifest.json holds the version
// the browser sees, package.json the one npm uses, and a release tag (v1.2.3)
// has to name that same version. Run by `npm run check`, locally and in CI.
//
// The tag comes from the environment GitHub Actions sets for a tag push, or
// from the command line: `node scripts/check-version.mjs v1.2.3`.

import { readFileSync } from "node:fs";

const versionIn = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).version;

const manifest = versionIn("../src/manifest.json");
const pkg = versionIn("../package.json");
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.argv[2];

const problems = [];
if (manifest !== pkg) problems.push(`src/manifest.json says ${manifest}, package.json says ${pkg}`);
if (tag && tag !== `v${manifest}`) problems.push(`the tag is ${tag}, the manifest's version needs v${manifest}`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`version check failed: ${problem}`);
  process.exit(1);
}
console.log(`version check: ${manifest}${tag ? ` matches the tag ${tag}` : ""}`);
