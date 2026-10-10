import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const distPath = join(packageRoot, "dist", "index.js")

function bunAvailable(): boolean {
  try {
    execFileSync("bun", ["--version"], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

describe("build artifact: dist/index.js", () => {
  it("exists", () => {
    assert.equal(existsSync(distPath), true, "dist/index.js missing — run npm run build")
  })

  it("keeps runtime dependencies external (regression: bundled ws broke Socket Mode under Bun)", () => {
    const bundle = readFileSync(distPath, "utf8")
    // The shipped bundle must import dependencies natively so the host
    // runtime (opencode embeds Bun) resolves them itself. esbuild's CJS
    // interop wrapping of an inlined `ws` breaks the Socket Mode WebSocket
    // upgrade handshake: every 101 response lands in ws' `response` handler
    // and surfaces as `Unexpected server response: 101`.
    assert.match(bundle, /from "@slack\/web-api"/)
    assert.match(bundle, /from "@slack\/socket-mode"/)
    assert.doesNotMatch(bundle, /\/\/ node_modules\//, "a dependency was inlined into the bundle")
    assert.doesNotMatch(bundle, /node_modules\/ws\//, "ws was inlined into the bundle")
  })

  it("does not rely on the dynamic-require shim (regression: bundle failed to load under Node)", () => {
    const bundle = readFileSync(distPath, "utf8")
    // A fully-bundled ESM build needs `typeof require` to be defined in ESM
    // scope (only Bun does that). Under Node the shim throws
    // `Dynamic require of "node:os" is not supported` at import time.
    assert.ok(
      !bundle.includes("Dynamic require of"),
      "bundle contains the esbuild dynamic-require shim; node_modules deps must stay external",
    )
  })

  it("uses native ESM imports for node builtins", () => {
    const bundle = readFileSync(distPath, "utf8")
    assert.match(bundle, /from "node:path"/)
  })

  it("loads under Node ESM and exports the plugin", async () => {
    const mod = await import(pathToFileURL(distPath).href)
    assert.equal(typeof mod.SlackBridge, "function")
  })

  it("loads under Node CJS (require(esm)) and exports the plugin", () => {
    const require = createRequire(import.meta.url)
    let mod: { SlackBridge?: unknown }
    try {
      mod = require(distPath) as { SlackBridge?: unknown }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === "ERR_REQUIRE_ESM") return // Node < 22: require(esm) unavailable
      throw error
    }
    assert.equal(typeof mod.SlackBridge, "function")
  })

  it("loads under Bun when Bun is installed (the runtime class where the bug appeared)", () => {
    if (!bunAvailable()) return // bun not installed locally; CI installs it
    const script = [
      `const mod = await import(${JSON.stringify(pathToFileURL(distPath).href)})`,
      `if (typeof mod.SlackBridge !== "function") throw new Error("SlackBridge export missing under Bun")`,
      `console.log("BUN_LOAD_OK")`,
    ].join("\n")
    const out = execFileSync("bun", ["-e", script], { encoding: "utf8" })
    assert.ok(out.includes("BUN_LOAD_OK"), `Bun failed to load the bundle:\n${out}`)
  })
})
