/**
 * Post-build step: bake a content fingerprint into the service worker's
 * cache name so a new shell build always invalidates cached old shells.
 *
 * The fingerprint is the sha256 of dist/index.html — the very document the
 * SW pre-caches. index.html references the hashed asset bundles, so ANY
 * front-end change rebuilds it with new references → new fingerprint → a
 * byte-different sw.js → browsers reinstall and drop the old cache (sw.js
 * activate deletes every cache whose name differs). Rebuilding the same
 * source yields the same fingerprint, so the name never churns needlessly.
 *
 * Exits non-zero when dist/index.html or dist/sw.js is missing or the
 * `__BUILD_ID__` placeholder cannot be found — a silent no-op would
 * regress to the "cached shell forever" bug this script exists to fix.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const indexHtml = readFileSync("dist/index.html", "utf8")
const buildId = createHash("sha256").update(indexHtml).digest("hex").slice(0, 10)

const swPath = "dist/sw.js"
const sw = readFileSync(swPath, "utf8")
const placeholder = "__BUILD_ID__"
if (!sw.includes(placeholder)) {
  console.error(`inject-sw-hash: ${placeholder} placeholder not found in ${swPath} — aborting`)
  process.exit(1)
}

writeFileSync(swPath, sw.replaceAll(placeholder, buildId))
console.log(`inject-sw-hash: cache name kclaw-shell-${buildId} baked into ${swPath}`)
