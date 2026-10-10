import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, loadDotenv } from "../src/config"

const SLACK_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_CHANNEL", "SLACK_ALLOWED_USERS", "SLACK_BRIDGE"]

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(SLACK_KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of SLACK_KEYS) delete process.env[key]
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) process.env[key] = value
    }
    fn()
  } finally {
    for (const key of SLACK_KEYS) {
      const previous = saved.get(key)
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }
}

describe("config: loadDotenv", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slack-bridge-config-"))
    cleanup = () => rmSync(dir, { recursive: true, force: true })
  })
  afterEach(() => cleanup())

  it("loads KEY=VALUE pairs from <directory>/.env", () => {
    writeFileSync(join(dir, ".env"), "SLACK_CHANNEL=C123\n")
    withEnv({}, () => {
      loadDotenv(dir)
      assert.equal(process.env.SLACK_CHANNEL, "C123")
    })
  })

  it("never clobbers variables already present in the environment", () => {
    writeFileSync(join(dir, ".env"), "SLACK_CHANNEL=CFromFile\n")
    withEnv({ SLACK_CHANNEL: "CFromEnv" }, () => {
      loadDotenv(dir)
      assert.equal(process.env.SLACK_CHANNEL, "CFromEnv")
    })
  })

  it("handles comments, blank lines, export prefixes, and quotes", () => {
    writeFileSync(
      join(dir, ".env"),
      [
        "# a comment",
        "",
        "export SLACK_CHANNEL='C123'",
        "SLACK_ALLOWED_USERS=U1, U2",
      ].join("\n"),
    )
    withEnv({}, () => {
      loadDotenv(dir)
      assert.equal(process.env.SLACK_CHANNEL, "C123")
      assert.equal(process.env.SLACK_ALLOWED_USERS, "U1, U2")
    })
  })

  it("tolerates a missing .env", () => {
    withEnv({}, () => {
      assert.doesNotThrow(() => loadDotenv(dir))
    })
  })
})

describe("config: loadConfig", () => {
  // loadConfig only probes <dir>/.env; a non-existent directory is fine.
  const dir = join(tmpdir(), "slack-bridge-config-missing")

  const valid = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_CHANNEL: "C123",
  }

  it("reports disabled when SLACK_BRIDGE is off", () => {
    withEnv({ ...valid, SLACK_BRIDGE: "off" }, () => {
      const result = loadConfig(dir)
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.reason, /SLACK_BRIDGE is off/)
    })
  })

  it("honours on/off spellings: false, 0, no (case-insensitive)", () => {
    for (const value of ["OFF", "false", "0", "No"]) {
      withEnv({ ...valid, SLACK_BRIDGE: value }, () => {
        assert.equal(loadConfig(dir).ok, false)
      })
    }
  })

  it("lists every missing variable in the reason", () => {
    withEnv({}, () => {
      const result = loadConfig(dir)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.match(result.reason, /SLACK_BOT_TOKEN/)
        assert.match(result.reason, /SLACK_APP_TOKEN/)
        assert.match(result.reason, /SLACK_CHANNEL/)
      }
    })
  })

  it("rejects tokens with wrong prefixes", () => {
    withEnv({ SLACK_BOT_TOKEN: "not-a-bot-token", SLACK_APP_TOKEN: "also-wrong", SLACK_CHANNEL: "C123" }, () => {
      const result = loadConfig(dir)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.match(result.reason, /must start with xoxb-/)
        assert.match(result.reason, /must start with xapp-/)
      }
    })
  })

  it("returns a trimmed config with parsed allowed users", () => {
    withEnv({ ...valid, SLACK_CHANNEL: " C123 ", SLACK_ALLOWED_USERS: "U1, ,U2," }, () => {
      const result = loadConfig(dir)
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.config.botToken, "xoxb-test")
        assert.equal(result.config.appToken, "xapp-test")
        assert.equal(result.config.channel, "C123")
        assert.deepEqual(result.config.allowedUsers, ["U1", "U2"])
      }
    })
  })

  it("treats an empty SLACK_ALLOWED_USERS as no allow-list (not an error)", () => {
    withEnv({ ...valid, SLACK_ALLOWED_USERS: "" }, () => {
      const result = loadConfig(dir)
      assert.equal(result.ok, true)
      if (result.ok) assert.deepEqual(result.config.allowedUsers, [])
    })
  })
})
