import { basename } from "node:path"
import { homedir } from "node:os"
import type { KnownBlock } from "@slack/types"

export type SlackBlock = KnownBlock

/** Normalized view of an opencode `permission.asked` event. */
export type PermissionInfo = {
  id: string
  sessionID: string
  kind: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
  title: string
}

/**
 * The runtime `permission.asked` payload is not the SDK `Permission` shape:
 *   { id, sessionID, permission, patterns, metadata, always, tool }
 */
export function normalizePermission(raw: unknown): PermissionInfo {
  const value = (raw ?? {}) as Record<string, unknown>
  const kind = typeof value.permission === "string" ? value.permission : "action"
  const patterns = Array.isArray(value.patterns)
    ? value.patterns.filter((item): item is string => typeof item === "string")
    : []
  const metadata =
    value.metadata && typeof value.metadata === "object"
      ? (value.metadata as Record<string, unknown>)
      : {}
  const always = Array.isArray(value.always)
    ? value.always.filter((item): item is string => typeof item === "string")
    : []
  const command = typeof metadata.command === "string" ? metadata.command : undefined
  const summary = patterns.length > 0 ? patterns.join(", ") : (command ?? "")
  return {
    id: typeof value.id === "string" ? value.id : "",
    sessionID: typeof value.sessionID === "string" ? value.sessionID : "",
    kind,
    patterns,
    always,
    metadata,
    title: summary ? `${kind}: ${summary}` : `${kind} requires approval`,
  }
}

/** Escape the three characters Slack interprets inside mrkdwn text. */
export function escapeMrkdwn(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function truncate(text: string, max = 280): string {
  const clean = (text ?? "").trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

/**
 * Strips host-specific detail from arbitrary text before it is posted to
 * Slack. Absolute macOS/Linux paths, Windows drive paths, and UNC share
 * paths are replaced with a `[path]` placeholder so no hostnames,
 * usernames, or local directory structure leak into the channel.
 */
export function redactHostInfo(text: string): string {
  const unixAbsolute = /(?<![\w./~-])\/(?:Users|home|root|private|var|tmp|etc|opt|usr|Volumes)\/[^\s"'`()<>[\]{}|;,]*/g
  const windowsDrive = /\b[A-Za-z]:\\[^\s"'`()<>[\]{}|;,]*/g
  const uncShare = /\\\\[^\\\s]+\\[^\s"'`()<>[\]{}|;,]*/g
  return (text ?? "")
    .replace(unixAbsolute, "[path]")
    .replace(windowsDrive, "[path]")
    .replace(uncShare, "[path]")
}

/**
 * Project name for a working directory, without any host detail. Returns
 * the directory's basename — the repo/project the agent is working on —
 * unless the session runs at the user's home directory itself, in which
 * case there is no project name to show.
 */
export function projectName(directory?: string): string {
  const dir = (directory ?? "").trim()
  if (!dir || dir === homedir()) return ""
  return basename(dir)
}

export function sessionRootText(title: string, directory?: string): string {
  const name = escapeMrkdwn(truncate(redactHostInfo(title) || "untitled session", 120))
  const project = projectName(directory)
  const where = project ? `\n_Project: ${escapeMrkdwn(project)}_` : ""
  return `*Session started* — ${name}${where}\nApprovals and replies stay in this thread.`
}

/** Root message for a child (subagent) session thread, created lazily. */
export function childSessionRootText(title: string, parentTitle?: string): string {
  const name = escapeMrkdwn(truncate(redactHostInfo(title) || "untitled subagent", 120))
  const parent = parentTitle
    ? ` _(child of ${escapeMrkdwn(truncate(redactHostInfo(parentTitle), 80))})_`
    : ""
  return `*Subagent session* — ${name}${parent}\nApprovals and replies for this subagent stay in this thread.`
}

/** One-line notice dropped into the parent thread when a child thread is created. */
export function childThreadPointerText(childTitle: string): string {
  return `🛑 Subagent _${escapeMrkdwn(truncate(redactHostInfo(childTitle), 80))}_ is requesting approval — see its thread below.`
}

/**
 * Compact, redacted context summary: the last few non-empty lines of text
 * (e.g. the tail of the last assistant message), suitable for the context
 * block of an approval or question card.
 */
export function recentContextLines(text: string, maxLines = 3, maxChars = 160): string {
  const clean = (text ?? "").trim()
  if (!clean) return ""
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines
    .slice(-maxLines)
    .map((line) => redactHostInfo(truncate(line, maxChars)))
    .join("\n")
}

/** One recent message worth of role-labelled text for a `/s` reply. */
export type StatusActivity = {
  role: string
  text: string
}

/**
 * Text for the ephemeral `/s` reply: the session title, any pending
 * approval/question markers, and the last few activity lines. Everything is
 * redacted and truncated exactly like the cards, so no host detail leaks.
 */
export function sessionStatusText(
  title: string,
  pending: { approval: boolean; question: boolean },
  activity: StatusActivity[],
): string {
  const name = escapeMrkdwn(truncate(redactHostInfo(title) || "untitled session", 120))
  const parts = [`*Session status* — ${name}`]
  if (pending.approval) parts.push("⏳ _Awaiting approval._")
  if (pending.question) parts.push("❓ _Question pending._")
  const lines = activity
    .map((entry) => {
      const context = recentContextLines(entry.text, 2, 200)
      return context ? `_${escapeMrkdwn(entry.role)}_:\n${escapeMrkdwn(context)}` : ""
    })
    .filter((line) => line.length > 0)
  parts.push(lines.length > 0 ? `_Recent activity:_\n${lines.join("\n")}` : "_No recent activity._")
  return parts.join("\n")
}

/**
 * Approval-card detail lines. Only the permission command and the always
 * patterns are forwarded, both redacted. Raw `filePath` / `file` / `path` /
 * `url` / `query` metadata is never echoed to Slack.
 */
function permissionDetails(permission: PermissionInfo): string[] {
  const details: string[] = []
  const command = permission.metadata.command
  if (typeof command === "string" && command.trim()) {
    details.push(`command: \`${escapeMrkdwn(truncate(redactHostInfo(command), 300))}\``)
  }
  if (permission.always.length > 0) {
    details.push(`always: \`${escapeMrkdwn(truncate(redactHostInfo(permission.always.join(", ")), 200))}\``)
  }
  return details
}

export function permissionText(permission: PermissionInfo): string {
  return `Approval needed: ${escapeMrkdwn(truncate(redactHostInfo(permission.title), 250))}`
}

export type PermissionAction = "once" | "always" | "reject"

export function permissionBlocks(
  permission: PermissionInfo,
  sessionTitle: string,
  actionPrefix: string,
  valueFor: (action: PermissionAction) => string,
  context?: string,
): SlackBlock[] {
  const title = escapeMrkdwn(truncate(redactHostInfo(permission.title || "action requires approval"), 250))
  const details = permissionDetails(permission)
  const contextParts = [
    `session: _${escapeMrkdwn(truncate(redactHostInfo(sessionTitle), 80))}_`,
    `type: \`${escapeMrkdwn(permission.kind)}\``,
  ]
  if (details.length > 0) contextParts.push(details.join("  ·  "))

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Approval needed*\n${title}` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join("\n") }],
    },
  ]
  if (context) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Recent context*\n${escapeMrkdwn(truncate(redactHostInfo(context), 600))}` },
    })
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: `${actionPrefix}:once`,
        text: { type: "plain_text", text: "Approve once" },
        style: "primary",
        value: valueFor("once"),
      },
      {
        type: "button",
        action_id: `${actionPrefix}:always`,
        text: { type: "plain_text", text: "Always" },
        value: valueFor("always"),
      },
      {
        type: "button",
        action_id: `${actionPrefix}:reject`,
        text: { type: "plain_text", text: "Reject" },
        style: "danger",
        value: valueFor("reject"),
      },
    ],
  })
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "You can also reply in this thread to send a prompt, or send `!abort` to stop the session.",
      },
    ],
  })
  return blocks
}

export function resolvedBlocks(label: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: escapeMrkdwn(label) },
    },
  ]
}

/** Normalized view of an opencode `question.asked` event. */
export type QuestionOption = { label: string; description: string }
export type QuestionItem = {
  question: string
  header: string
  options: QuestionOption[]
  multiple: boolean
  custom: boolean
}
export type QuestionRequestInfo = {
  id: string
  sessionID: string
  questions: QuestionItem[]
}

export function normalizeQuestion(raw: unknown): QuestionRequestInfo {
  const value = (raw ?? {}) as Record<string, unknown>
  const questions = Array.isArray(value.questions)
    ? value.questions.map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>
        const options = Array.isArray(item.options)
          ? item.options.map((opt) => {
              const o = (opt ?? {}) as Record<string, unknown>
              return { label: String(o.label ?? ""), description: String(o.description ?? "") }
            })
          : []
        return {
          question: String(item.question ?? ""),
          header: String(item.header ?? "Question"),
          options,
          multiple: item.multiple === true,
          custom: item.custom === true,
        }
      })
    : []
  return {
    id: typeof value.id === "string" ? value.id : "",
    sessionID: typeof value.sessionID === "string" ? value.sessionID : "",
    questions,
  }
}

export function questionText(info: QuestionRequestInfo): string {
  const header = info.questions[0]?.header ?? "the agent has a question"
  return `Input needed: ${escapeMrkdwn(truncate(redactHostInfo(header), 120))}`
}

export function questionBlocks(
  info: QuestionRequestInfo,
  sessionTitle: string,
  actionPrefix: string,
  selected: string[][],
  notice?: string,
  context?: string,
): SlackBlock[] {
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Input needed* — _${escapeMrkdwn(truncate(redactHostInfo(sessionTitle), 80))}_`,
      },
    },
  ]

  if (context) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Recent context*\n${escapeMrkdwn(truncate(redactHostInfo(context), 600))}` },
    })
  }

  info.questions.forEach((question, index) => {
    const chosen = selected[index] ?? []
    const header = `*Q${index + 1}. ${escapeMrkdwn(truncate(redactHostInfo(question.header), 60))}*`
    const body = escapeMrkdwn(truncate(redactHostInfo(question.question), 500))
    const hints: string[] = []
    if (question.multiple) hints.push("_Select one or more, then Submit._")
    if (question.custom) hints.push("_Or reply in the thread with your own answer._")
    const hint = hints.length > 0 ? `\n${hints.join(" ")}` : ""
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${header}\n${body}${hint}` } })

    if (question.options.length > 0) {
      const elements = question.options.map((option, optionIndex) => {
        const button: Record<string, unknown> = {
          type: "button",
          action_id: `${actionPrefix}:qopt:${index}:${optionIndex}`,
          text: { type: "plain_text", text: truncate(redactHostInfo(option.label || option.description), 75) },
          value: JSON.stringify({
            kind: "qopt",
            requestID: info.id,
            sessionID: info.sessionID,
            index,
            optionIndex,
          }),
        }
        if (chosen.includes(option.label)) button.style = "primary"
        return button
      })
      blocks.push({ type: "actions", elements })
    }
  })

  if (notice) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(notice) }] })
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: `${actionPrefix}:qsubmit`,
        text: { type: "plain_text", text: "Submit answers" },
        style: "primary",
        value: JSON.stringify({ kind: "qsubmit", requestID: info.id, sessionID: info.sessionID }),
      },
      {
        type: "button",
        action_id: `${actionPrefix}:qreject`,
        text: { type: "plain_text", text: "Reject" },
        style: "danger",
        value: JSON.stringify({ kind: "qreject", requestID: info.id, sessionID: info.sessionID }),
      },
    ],
  })

  return blocks as SlackBlock[]
}
