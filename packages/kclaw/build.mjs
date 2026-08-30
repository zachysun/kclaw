import { build } from "esbuild"
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url)) // repo root

rmSync("app", { recursive: true, force: true })
mkdirSync("app/server/bin", { recursive: true })

// CLI: bundle dist entry, inline @kclaw/core, externalize npm deps. Because
// @kclaw/core is inlined here, its runtime deps are externalized too (the
// union below matches kclaw's package.json dependencies) — better-sqlite3 is
// a native module and must never be bundled.
await build({
  entryPoints: [`${root}/packages/cli/dist/index.js`],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "app/cli/cli.js",
  external: [
    "@clack/prompts",
    "commander",
    "ws",
    "better-sqlite3",
    "cron-parser",
    "yaml",
    "ulidx",
    "@modelcontextprotocol/sdk",
    "@mozilla/readability",
    "linkedom",
  ],
  // No shebang banner: the tsc-built cli/dist/index.js already carries its
  // own `#!/usr/bin/env node` on line 1 (esbuild preserves it); a banner here
  // would push that to line 2, where a hashbang is a syntax error.
})

// server: bundle the bin SHELL, not dist/index.js. The shell is the actual
// bin entry: it top-level-executes launchDaemon(), prints the ready line and
// owns the SIGTERM/SIGINT -> daemon.stop() handlers; dist/index.js is a pure
// library that would start nothing on its own. esbuild follows the shell's
// `../dist/index.js` import and inlines the whole daemon.
await build({
  entryPoints: [`${root}/packages/server/bin/kclaw-server.mjs`],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "app/server/bin/kclaw-server.mjs",
  external: [
    "fastify",
    "@fastify/static",
    "@fastify/websocket",
    "ws",
    "better-sqlite3",
    "cron-parser",
    "yaml",
    "ulidx",
    "@modelcontextprotocol/sdk",
    "@mozilla/readability",
    "linkedom",
  ],
})

// web static shell, at the path defaultWebDistPath expects from app/server/bin
// (`../../web/dist` -> app/web/dist).
cpSync(`${root}/packages/web/dist`, "app/web/dist", { recursive: true })

// Version stubs: the bundled CLI (cli/src/index.ts) and daemon
// (server/src/app.ts) each read `../package.json` relative to
// import.meta.url at runtime — from app/cli/cli.js that is app/package.json,
// from app/server/bin/kclaw-server.mjs it is app/server/package.json.
const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version
// "type":"module" matters: app/package.json is the nearest package.json to
// app/cli/cli.js and must keep it ESM (the .mjs daemon bin would be ESM
// regardless, but keep both stubs uniform).
const stub = `${JSON.stringify({ name: "kclaw", version, type: "module" }, null, 2)}\n`
writeFileSync("app/package.json", stub)
writeFileSync("app/server/package.json", stub)

chmodSync("app/cli/cli.js", 0o755)
chmodSync("app/server/bin/kclaw-server.mjs", 0o755)

// Regression guard: @modelcontextprotocol/sdk must stay externalized (it is
// inlined above only if someone removes it from the external lists) — inlining
// it drags cross-spawn in, whose runtime require("child_process") throws inside
// an ESM bundle and kills every command. Fail the build the moment either
// bundle re-inlines it.
for (const out of ["app/cli/cli.js", "app/server/bin/kclaw-server.mjs"]) {
  const text = readFileSync(new URL(out, import.meta.url), "utf8")
  if (text.includes("cross-spawn")) {
    console.error(`kclaw: ${out} inlined cross-spawn — keep @modelcontextprotocol/sdk externalized`)
    process.exit(1)
  }
}

console.log("kclaw: app/ assembled")
