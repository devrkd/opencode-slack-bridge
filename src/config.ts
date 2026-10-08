import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type BridgeConfig = {
  botToken: string
  appToken: string
  channel: string
  allowedUsers: string[]
}

export type ConfigResult =
  | { ok: true; config: BridgeConfig }
  | { ok: false; reason: string }

function parseEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    let key = line.slice(0, eq).trim()
    if (key.startsWith("export ")) key = key.slice("export ".length).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      const quoted =
        (first === '"' && last === '"') || (first === "'" && last === "'")
      if (quoted) value = value.slice(1, -1)
    }
    if (key) result[key] = value
  }
  return result
}

/**
 * Loads KEY=VALUE pairs from <directory>/.env into process.env.
 * Existing environment variables always win, so exported values are
 * never clobbered by the file.
 */
export function loadDotenv(directory: string): void {
  const file = join(directory, ".env")
  if (!existsSync(file)) return
  let parsed: Record<string, string>
  try {
    parsed = parseEnv(readFileSync(file, "utf8"))
  } catch {
    return
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function isOff(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === "off" || v === "false" || v === "0" || v === "no"
}

export function loadConfig(directory: string): ConfigResult {
  if (isOff(process.env.SLACK_BRIDGE)) {
    return { ok: false, reason: "SLACK_BRIDGE is off" }
  }

  loadDotenv(directory)

  const botToken = (process.env.SLACK_BOT_TOKEN ?? "").trim()
  const appToken = (process.env.SLACK_APP_TOKEN ?? "").trim()
  const channel = (process.env.SLACK_CHANNEL ?? "").trim()
  const allowedUsers = (process.env.SLACK_ALLOWED_USERS ?? "")
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean)

  const problems: string[] = []
  if (!botToken) problems.push("SLACK_BOT_TOKEN")
  else if (!botToken.startsWith("xoxb-"))
    problems.push("SLACK_BOT_TOKEN (must start with xoxb-)")
  if (!appToken) problems.push("SLACK_APP_TOKEN")
  else if (!appToken.startsWith("xapp-"))
    problems.push("SLACK_APP_TOKEN (must start with xapp-)")
  if (!channel) problems.push("SLACK_CHANNEL")

  if (problems.length > 0) {
    return { ok: false, reason: `missing or invalid ${problems.join(", ")}` }
  }

  return { ok: true, config: { botToken, appToken, channel, allowedUsers } }
}
