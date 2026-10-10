import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionMap, type SessionRef } from "../src/session-map"

function ref(overrides: Partial<SessionRef> = {}): SessionRef {
  return { channel: "C123", ts: "1791667139.684139", title: "t", createdAt: 1, ...overrides }
}

describe("session-map", () => {
  let dir: string
  let file: string
  let cleanup: () => void

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slack-bridge-map-"))
    file = join(dir, "state", "slack-bridge-state.json")
    cleanup = () => rmSync(dir, { recursive: true, force: true })
  })
  afterEach(() => cleanup())

  it("starts empty when the state file does not exist", () => {
    const map = new SessionMap(file)
    assert.equal(map.has("s1"), false)
  })

  it("creates the parent directory and persists on set", () => {
    const map = new SessionMap(file)
    map.set("s1", ref())
    assert.equal(map.has("s1"), true)
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, SessionRef>
    assert.equal(raw.s1.ts, "1791667139.684139")
  })

  it("restores entries from an existing state file (restart keeps threads)", () => {
    new SessionMap(file).set("s1", ref({ title: "fix bug" }))
    const restored = new SessionMap(file)
    assert.equal(restored.get("s1")?.title, "fix bug")
  })

  it("removes entries on delete and persists the removal", () => {
    const map = new SessionMap(file)
    map.set("s1", ref())
    map.delete("s1")
    assert.equal(map.has("s1"), false)
    assert.equal(new SessionMap(file).has("s1"), false)
  })

  it("keeps child session markers (parentID) across restarts", () => {
    new SessionMap(file).set("child", ref({ parentID: "parent" }))
    assert.equal(new SessionMap(file).get("child")?.parentID, "parent")
  })

  it("maps a Slack thread ts back to its session id", () => {
    const map = new SessionMap(file)
    map.set("s1", ref({ ts: "111.1" }))
    map.set("s2", ref({ ts: "222.2" }))
    assert.equal(map.sessionForThread("111.1"), "s1")
    assert.equal(map.sessionForThread("222.2"), "s2")
    assert.equal(map.sessionForThread("999.9"), undefined)
  })

  it("starts clean instead of throwing on a corrupt state file", () => {
    mkdirSync(join(dir, "state"), { recursive: true })
    writeFileSync(file, "{ not json !!!")
    const map = new SessionMap(file)
    assert.equal(map.has("s1"), false)
    assert.doesNotThrow(() => map.set("s1", ref()))
  })

  it("skips malformed entries instead of trusting the file blindly", () => {
    mkdirSync(join(dir, "state"), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        good: ref(),
        bad: { channel: 42 },
        worse: null,
      }),
    )
    const map = new SessionMap(file)
    assert.equal(map.has("good"), true)
    assert.equal(map.has("bad"), false)
    assert.equal(map.has("worse"), false)
  })

  it("exposes entries for iteration (used by /s and stale-click checks)", () => {
    const map = new SessionMap(file)
    map.set("s1", ref({ ts: "111.1" }))
    map.set("s2", ref({ ts: "222.2" }))
    assert.deepEqual(
      [...map.entries()].map(([id]) => id).sort(),
      ["s1", "s2"],
    )
  })
})
