import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { mkdirSync, renameSync } from "node:fs"

mkdirSync("dist", { recursive: true })

await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/index.js",
  external: ["node:*"], // node builtins provided by the runtime
  sourcemap: false,
})

const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit", shell: true })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

// tsc emits dist/plugin.d.ts; the package contract is dist/index.d.ts
renameSync("dist/plugin.d.ts", "dist/index.d.ts")
