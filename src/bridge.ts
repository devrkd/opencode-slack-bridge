import { join } from "node:path"
import { WebClient } from "@slack/web-api"
import { SocketModeClient } from "@slack/socket-mode"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Session } from "@opencode-ai/sdk"
import { loadConfig } from "./config"
import { SessionMap, type SessionRef } from "./session-map"
import {
  childSessionRootText,
  childThreadPointerText,
  escapeMrkdwn,
  normalizePermission,
  normalizeQuestion,
  permissionBlocks,
  permissionText,
  questionBlocks,
  questionText,
  recentContextLines,
  redactHostInfo,
  resolvedBlocks,
  sessionRootText,
  sessionStatusText,
  truncate,
  type PermissionAction,
  type PermissionInfo,
  type QuestionRequestInfo,
  type StatusActivity,
} from "./format"

type OpenCodeClient = PluginInput["client"]

export type Bridge = {
  onEvent(event: { type: string; properties: unknown }): Promise<void>
  dispose(): Promise<void>
}

const SERVICE = "slack-bridge"
const ACTION_PREFIX = "slackbridge"

/** Built-in Slack emoji used as the in-progress loader on a session's root message. */
const LOADER_EMOJI = "hourglass_flowing_sand"
/** Built-in Slack emoji that replaces the loader when a session ends. */
const DONE_EMOJI = "white_check_mark"

/** Reaction applied to a session's root message; absence means none. */
type ReactionState = "loading" | "done"

/** Emoji shown for a tracked reaction state. */
function emojiFor(state: ReactionState): string {
  return state === "loading" ? LOADER_EMOJI : DONE_EMOJI
}

type SlashCommandBody = {
  command?: string
  text?: string
  channel_id?: string
  user_id?: string
  team_id?: string
  trigger_id?: string
  response_url?: string
  user_name?: string
  channel_name?: string
  api_app_id?: string
}

type PendingPermission = {
  channel: string
  ts: string
  sessionID: string
}

type PendingQuestion = {
  channel: string
  ts: string
  sessionID: string
  info: QuestionRequestInfo
  selected: string[][]
}

export async function createBridge(input: PluginInput): Promise<Bridge | null> {
  const result = loadConfig(input.directory)

  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await input.client.app.log({ body: { service: SERVICE, level, message, extra } })
    } catch {
      // logging must never break the agent
    }
  }

  if (!result.ok) {
    await log("warn", `disabled: ${result.reason}`)
    return null
  }

  const config = result.config
  const client: OpenCodeClient = input.client
  const web = new WebClient(config.botToken)
  const socket = new SocketModeClient({ appToken: config.appToken })
  const sessions = new SessionMap(join(input.directory, ".opencode", "slack-bridge-state.json"))
  const childSessions = new Set<string>()
  const threadLocks = new Map<string, Promise<SessionRef | null>>()
  const pendingPermissions = new Map<string, PendingPermission>()
  const pendingQuestions = new Map<string, PendingQuestion>()
  /** sessionID -> reaction currently on its root message (in-memory only); absence means none. */
  const statusReactions = new Map<string, ReactionState>()
  const serverUrl = input.serverUrl

  if (config.allowedUsers.length === 0) {
    await log("warn", "SLACK_ALLOWED_USERS is empty; any member of the channel can answer approvals")
  }

  async function resolveParentTitle(parentID: string): Promise<string> {
    try {
      const parent = await client.session.get({ path: { id: parentID } })
      return parent.data?.title ?? ""
    } catch {
      // best-effort label only
      return ""
    }
  }

  async function ensureThread(sessionID: string): Promise<SessionRef | null> {
    const existing = sessions.get(sessionID)
    if (existing) return existing

    const inflight = threadLocks.get(sessionID)
    if (inflight) return inflight

    const task = (async (): Promise<SessionRef | null> => {
      let info: Session | undefined
      try {
        const res = await client.session.get({ path: { id: sessionID } })
        info = res.data
      } catch {
        return null
      }
      if (!info) return null
      if (info.parentID) childSessions.add(sessionID)
      const isChild = info.parentID !== undefined
      const parentTitle = info.parentID ? await resolveParentTitle(info.parentID) : ""
      const title = info.title || "untitled session"
      const rootText = isChild
        ? childSessionRootText(title, parentTitle)
        : sessionRootText(title, info.directory)
      try {
        const posted = await web.chat.postMessage({
          channel: config.channel,
          text: rootText,
          mrkdwn: true,
        })
        if (!posted.ts) return null
        const ref: SessionRef = {
          channel: config.channel,
          ts: posted.ts,
          title,
          createdAt: Date.now(),
          ...(info.parentID ? { parentID: info.parentID } : {}),
        }
        sessions.set(sessionID, ref)
        await setStatusReaction(sessionID, ref, "loading")
        await log("info", "created Slack thread", {
          sessionID,
          ts: ref.ts,
          title,
          ...(isChild ? { child: true, parentID: info.parentID } : {}),
        })
        return ref
      } catch {
        return null
      }
    })()

    threadLocks.set(sessionID, task)
    try {
      return await task
    } finally {
      threadLocks.delete(sessionID)
    }
  }

  async function postThread(ref: SessionRef, text: string): Promise<void> {
    try {
      await web.chat.postMessage({
        channel: ref.channel,
        thread_ts: ref.ts,
        text,
        mrkdwn: true,
      })
    } catch {
      // best-effort
    }
  }

  /**
   * True when a reactions.add/remove error simply means the desired state
   * already holds (e.g. Slack's `already_reacted` / `no_reaction`) or the
   * message is gone — nothing more to do.
   */
  function isReactionNoop(error: unknown, codes: string[]): boolean {
    const dataError = (error as { data?: { error?: string } }).data?.error
    const message = describeError(error)
    return codes.some((code) => dataError === code || message.includes(code))
  }

  /**
   * Idempotently applies the desired reaction state on a session's root
   * message: the loader while busy, the done check mark once ended. State is
   * tracked in memory (no Slack call is repeated for the same state), and
   * Slack's `already_reacted` / `no_reaction` / `message_not_found` errors
   * are tolerated as success. Best-effort: failures leave the tracked state
   * untouched so the next activity signal retries.
   */
  async function setStatusReaction(
    sessionID: string,
    ref: SessionRef,
    next: ReactionState,
  ): Promise<void> {
    if (!ref.ts) return
    const current = statusReactions.get(sessionID)
    if (current === next) return
    if (current) {
      // Remove the previously applied emoji first so a swap never stacks two.
      try {
        await web.reactions.remove({ channel: ref.channel, timestamp: ref.ts, name: emojiFor(current) })
      } catch (error) {
        if (!isReactionNoop(error, ["no_reaction", "message_not_found"])) return
      }
    }
    try {
      await web.reactions.add({ channel: ref.channel, timestamp: ref.ts, name: emojiFor(next) })
    } catch (error) {
      if (!isReactionNoop(error, ["already_reacted", "message_not_found"])) return
    }
    statusReactions.set(sessionID, next)
  }

  /** Mark a session as busy: shows (or restores) the loader on its root message if the thread exists. */
  async function markActive(sessionID: string): Promise<void> {
    const ref = sessions.get(sessionID)
    if (!ref) return
    await setStatusReaction(sessionID, ref, "loading")
  }

  /** Best-effort ephemeral reply visible only to the invoking Slack user. */
  async function replyEphemeral(channel: string, user: string, text: string): Promise<void> {
    try {
      await web.chat.postEphemeral({ channel, user, text })
    } catch {
      // best-effort
    }
  }

  async function lastAssistantText(sessionID: string): Promise<string> {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const messages = res.data ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.info.role !== "assistant") continue
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n")
          .trim()
        if (text) return text
      }
    } catch {
      // ignore
    }
    return ""
  }

  function permissionValue(permission: PermissionInfo, action: PermissionAction): string {
    return JSON.stringify({
      kind: "permission",
      sessionID: permission.sessionID,
      permissionID: permission.id,
      response: action,
    })
  }

  /** Extract a readable message from whatever shape a submit error came in. */
  function describeError(error: unknown): string {
    if (error instanceof Error) return error.message
    const data = (error as { data?: { message?: string } }).data
    if (data && typeof data.message === "string") return data.message
    const name = (error as { name?: string }).name
    if (typeof name === "string") return name
    return String(error)
  }

  async function onPermission(permission: PermissionInfo): Promise<void> {
    if (!permission.id || !permission.sessionID) return
    const hadThread = sessions.has(permission.sessionID)
    const ref = await ensureThread(permission.sessionID)
    if (!ref) return
    await markActive(permission.sessionID)
    if (!hadThread && ref.parentID) {
      const parent = sessions.get(ref.parentID)
      if (parent) {
        await postThread(parent, childThreadPointerText(ref.title))
        await log("info", "child thread pointer posted", {
          parentID: ref.parentID,
          childSessionID: permission.sessionID,
        })
      }
    }
    const context = recentContextLines(await lastAssistantText(permission.sessionID))
    try {
      const posted = await web.chat.postMessage({
        channel: ref.channel,
        thread_ts: ref.ts,
        text: permissionText(permission),
        blocks: permissionBlocks(
          permission,
          ref.title,
          ACTION_PREFIX,
          (action) => permissionValue(permission, action),
          context,
        ),
      })
      if (posted.ts) {
        pendingPermissions.set(permission.id, {
          channel: ref.channel,
          ts: posted.ts,
          sessionID: permission.sessionID,
        })
        await log("info", ref.parentID ? "child approval card posted" : "approval card posted", {
          permissionID: permission.id,
          sessionID: permission.sessionID,
          ...(ref.parentID ? { parentID: ref.parentID } : {}),
        })
      }
    } catch {
      // best-effort
    }
  }

  async function onPermissionReplied(props: { sessionID: string; requestID: string; reply: string }): Promise<void> {
    const pending = pendingPermissions.get(props.requestID)
    if (!pending) return
    pendingPermissions.delete(props.requestID)
    await log("info", "approval resolved elsewhere", {
      requestID: props.requestID,
      reply: props.reply,
    })
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: `Approval resolved in terminal: ${props.reply}`,
        blocks: resolvedBlocks(`Approval resolved in terminal: \`${props.reply}\``),
      })
    } catch {
      // best-effort
    }
  }

  async function renderQuestion(requestID: string, notice?: string): Promise<void> {
    const pending = pendingQuestions.get(requestID)
    if (!pending) return
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: questionText(pending.info),
        blocks: questionBlocks(
          pending.info,
          sessions.get(pending.sessionID)?.title ?? "",
          ACTION_PREFIX,
          pending.selected,
          notice,
        ),
      })
    } catch {
      // best-effort
    }
  }

  async function replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    try {
      const url = new URL(`/question/${requestID}/reply`, serverUrl)
      url.searchParams.set("directory", input.directory)
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      })
      if (!response.ok) {
        await log("error", "question reply failed", { requestID, status: response.status })
        return false
      }
      return true
    } catch (error) {
      await log("error", "question reply error", { requestID, error: String(error) })
      return false
    }
  }

  async function submitQuestion(requestID: string): Promise<void> {
    const pending = pendingQuestions.get(requestID)
    if (!pending) {
      await log("warn", "ignored stale question action", { requestID })
      return
    }
    const answers = pending.info.questions.map((_, index) => pending.selected[index] ?? [])
    if (answers.some((answer) => answer.length === 0)) {
      await renderQuestion(requestID, "Answer every question before submitting.")
      return
    }
    const ok = await replyQuestion(requestID, answers)
    if (!ok) return
    pendingQuestions.delete(requestID)
    await markActive(pending.sessionID)
    await log("info", "question answered from Slack", { requestID })
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: "Answered from Slack.",
        blocks: resolvedBlocks("*Answered from Slack.*"),
      })
    } catch {
      // best-effort
    }
  }

  async function rejectQuestion(requestID: string): Promise<void> {
    const pending = pendingQuestions.get(requestID)
    if (!pending) {
      await log("warn", "ignored stale question action", { requestID })
      return
    }
    try {
      const url = new URL(`/question/${requestID}/reject`, serverUrl)
      url.searchParams.set("directory", input.directory)
      await fetch(url, { method: "POST" })
    } catch (error) {
      await log("error", "question reject error", { requestID, error: String(error) })
    }
    pendingQuestions.delete(requestID)
    await log("info", "question rejected from Slack", { requestID })
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: "Rejected from Slack.",
        blocks: resolvedBlocks("*Rejected from Slack.*"),
      })
    } catch {
      // best-effort
    }
  }

  async function onQuestion(info: QuestionRequestInfo): Promise<void> {
    if (!info.id || !info.sessionID || info.questions.length === 0) return
    const hadThread = sessions.has(info.sessionID)
    const ref = await ensureThread(info.sessionID)
    if (!ref) return
    await markActive(info.sessionID)
    if (!hadThread && ref.parentID) {
      const parent = sessions.get(ref.parentID)
      if (parent) {
        await postThread(parent, childThreadPointerText(ref.title))
        await log("info", "child thread pointer posted", {
          parentID: ref.parentID,
          childSessionID: info.sessionID,
        })
      }
    }
    const context = recentContextLines(await lastAssistantText(info.sessionID))
    const selected = info.questions.map(() => [] as string[])
    try {
      const posted = await web.chat.postMessage({
        channel: ref.channel,
        thread_ts: ref.ts,
        text: questionText(info),
        blocks: questionBlocks(info, ref.title, ACTION_PREFIX, selected, undefined, context),
      })
      if (!posted.ts) return
      pendingQuestions.set(info.id, {
        channel: ref.channel,
        ts: posted.ts,
        sessionID: info.sessionID,
        info,
        selected,
      })
      await log("info", "question card posted", { requestID: info.id, sessionID: info.sessionID })
    } catch {
      // best-effort
    }
  }

  async function onQuestionResolved(requestID: string, label: string): Promise<void> {
    const pending = pendingQuestions.get(requestID)
    if (!pending) return
    pendingQuestions.delete(requestID)
    await log("info", "question resolved elsewhere", { requestID, label })
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: label,
        blocks: resolvedBlocks(`*${label}*`),
      })
    } catch {
      // best-effort
    }
  }

  /**
   * Resolves every pending permission/question card registered for a session:
   * entries are removed from the pending maps and their Slack cards are
   * updated to a resolved label (best-effort). Used when a session is deleted
   * so no orphan approval cards linger and stale state can't resolve
   * unrelated sessions.
   */
  async function resolvePendingForSession(sessionID: string, label: string): Promise<void> {
    for (const [id, pending] of [...pendingPermissions]) {
      if (pending.sessionID !== sessionID) continue
      pendingPermissions.delete(id)
      await log("info", "orphaned card resolved", {
        sessionID,
        label,
        kind: "permission",
        permissionID: id,
      })
      try {
        await web.chat.update({
          channel: pending.channel,
          ts: pending.ts,
          text: label,
          blocks: resolvedBlocks(`*${label}*`),
        })
      } catch {
        // best-effort
      }
    }
    for (const [id, pending] of [...pendingQuestions]) {
      if (pending.sessionID !== sessionID) continue
      pendingQuestions.delete(id)
      await log("info", "orphaned card resolved", {
        sessionID,
        label,
        kind: "question",
        requestID: id,
      })
      try {
        await web.chat.update({
          channel: pending.channel,
          ts: pending.ts,
          text: label,
          blocks: resolvedBlocks(`*${label}*`),
        })
      } catch {
        // best-effort
      }
    }
  }

  async function onEvent(event: { type: string; properties: unknown }): Promise<void> {
    switch (event.type) {
      case "session.created": {
        const info = (event.properties as { info: Session }).info
        if (info.parentID) {
          childSessions.add(info.id)
          return
        }
        await ensureThread(info.id)
        return
      }
      case "session.updated": {
        const info = (event.properties as { info: Session }).info
        if (info.parentID) childSessions.add(info.id)
        const ref = sessions.get(info.id)
        if (!ref) {
          if (info.parentID) return
          await ensureThread(info.id)
          return
        }
        if (info.title && info.title !== ref.title) {
          ref.title = info.title
          sessions.set(info.id, ref)
          const rootText = ref.parentID
            ? childSessionRootText(info.title, await resolveParentTitle(ref.parentID))
            : sessionRootText(info.title, info.directory)
          try {
            await web.chat.update({
              channel: ref.channel,
              ts: ref.ts,
              text: rootText,
            })
          } catch {
            // best-effort
          }
        }
        return
      }
      case "session.idle": {
        // Routine progress is intentionally not mirrored to Slack; the only
        // proactive posts are approval and question cards. The session is
        // done, so replace the loader reaction with a done check mark.
        const { sessionID } = event.properties as { sessionID?: string }
        if (sessionID) {
          const ref = sessions.get(sessionID)
          if (ref) await setStatusReaction(sessionID, ref, "done")
        }
        return
      }
      case "session.error": {
        const { sessionID, error } = event.properties as { sessionID?: string; error?: unknown }
        if (!sessionID) return
        // Errors are not posted to Slack (they can contain host detail);
        // they stay in the local opencode app log.
        await log("error", "session error (not posted to Slack)", {
          sessionID,
          error: describeError(error),
        })
        return
      }
      case "todo.updated": {
        // Plan updates are routine progress and are not mirrored to Slack.
        return
      }
      case "permission.asked":
      case "permission.updated": {
        await onPermission(normalizePermission(event.properties))
        return
      }
      case "permission.replied": {
        await onPermissionReplied(
          event.properties as { sessionID: string; requestID: string; reply: string },
        )
        return
      }
      case "question.asked":
      case "question.v2.asked": {
        await onQuestion(normalizeQuestion(event.properties))
        return
      }
      case "question.replied":
      case "question.v2.replied": {
        await onQuestionResolved(
          (event.properties as { requestID?: string }).requestID ?? "",
          "Answered elsewhere (_terminal_).",
        )
        return
      }
      case "question.rejected":
      case "question.v2.rejected": {
        await onQuestionResolved(
          (event.properties as { requestID?: string }).requestID ?? "",
          "Rejected elsewhere (_terminal_).",
        )
        return
      }
      case "session.deleted": {
        const info = event.properties as { info?: { id?: string } }
        const sessionID = info.info?.id
        if (!sessionID) return
        const ref = sessions.get(sessionID)
        childSessions.delete(sessionID)
        sessions.delete(sessionID)
        // The session is over: swap the loader for the done check mark on
        // the root message, then drop the in-memory reaction state — no
        // further events can target this session, so nothing will retry it.
        if (ref) await setStatusReaction(sessionID, ref, "done")
        statusReactions.delete(sessionID)
        await resolvePendingForSession(sessionID, "Session ended — pending request discarded.")
        return
      }
      default:
        return
    }
  }

  function authorized(userID: string | undefined): boolean {
    if (!userID) return false
    if (config.allowedUsers.length === 0) return true
    return config.allowedUsers.includes(userID)
  }

  async function onAction(body: {
    channel?: { id?: string }
    message?: { ts?: string }
    user?: { id?: string }
    actions?: Array<{ action_id?: string; value?: string }>
  }): Promise<void> {
    const action = body.actions?.[0]
    if (!action?.action_id || !action.action_id.startsWith(ACTION_PREFIX)) return
    const channelID = body.channel?.id
    const messageTs = body.message?.ts
    if (!channelID || !messageTs) return

    if (!authorized(body.user?.id)) {
      await log("warn", `ignored approval from unauthorized user ${body.user?.id ?? "unknown"}`)
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(action.value ?? "{}") as Record<string, unknown>
    } catch {
      return
    }

    const kind = typeof payload.kind === "string" ? payload.kind : "permission"

    if (kind === "qopt") {
      const requestID = String(payload.requestID ?? "")
      const pending = pendingQuestions.get(requestID)
      if (!pending) {
        await log("warn", "ignored stale question action", {
          requestID,
          user: body.user?.id,
        })
        return
      }
      const index = Number(payload.index)
      const optionIndex = Number(payload.optionIndex)
      if (!Number.isInteger(index) || !Number.isInteger(optionIndex)) return
      const question = pending.info.questions[index]
      // Resolve the option from the pending request itself instead of
      // trusting anything in the button payload.
      const label = question?.options[optionIndex]?.label
      if (!question || !label) return
      const current = pending.selected[index] ?? []
      if (question.multiple) {
        pending.selected[index] = current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label]
      } else {
        pending.selected[index] = [label]
      }
      const allSingleSelect = pending.info.questions.every((question) => !question.multiple)
      const complete = pending.info.questions.every(
        (_, i) => (pending.selected[i] ?? []).length > 0,
      )
      if (allSingleSelect && complete) {
        await submitQuestion(requestID)
      } else {
        await renderQuestion(requestID)
      }
      return
    }

    if (kind === "qsubmit") {
      await submitQuestion(String(payload.requestID ?? ""))
      return
    }

    if (kind === "qreject") {
      await rejectQuestion(String(payload.requestID ?? ""))
      return
    }

    const sessionID = String(payload.sessionID ?? "")
    const permissionID = String(payload.permissionID ?? "")
    const response = payload.response as PermissionAction
    if (!sessionID || !permissionID || !response) return

    // Only honour a button value the bridge itself registered for this
    // permissionID/sessionID pair — a stale or replayed click for an
    // already-resolved permission must never be submitted.
    const pendingPermission = pendingPermissions.get(permissionID)
    if (!pendingPermission || pendingPermission.sessionID !== sessionID) {
      await log("warn", "ignored stale approval", {
        permissionID,
        sessionID,
        user: body.user?.id,
      })
      return
    }

    // Submit the approval. The SDK does not throw on HTTP errors by default
    // (it returns a result tuple), so inspect both the tuple and any thrown
    // transport error to tell a genuinely dead session apart from a transient
    // failure: only discard the pending card when opencode definitively
    // rejected the submit (4xx).
    let rejected = false
    let submitStatus: number | undefined
    let submitError: unknown
    try {
      const result = await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID },
        body: { response },
      })
      if (result.error) {
        rejected = true
        submitStatus = result.response.status
        submitError = result.error
      }
    } catch (error) {
      rejected = true
      submitError = error
      submitStatus = (error as { cause?: { status?: number } }).cause?.status
    }

    if (rejected) {
      const deadSession = submitStatus !== undefined && submitStatus >= 400 && submitStatus < 500
      if (!deadSession) {
        // Transient failure (5xx, network blip): the session may still be
        // alive, so keep the pending entry and leave the card live for a
        // retry instead of burning a pending approval.
        await log("warn", "approval submit failed; card left live", {
          permissionID,
          sessionID,
          error: describeError(submitError),
          status: submitStatus,
        })
        return
      }
      // The session (e.g. a finished-but-persisted child) can no longer accept
      // the approval: discard it instead of leaving a live-looking card.
      pendingPermissions.delete(permissionID)
      await log("warn", "approval discarded: session inactive", {
        permissionID,
        sessionID,
        error: describeError(submitError),
        status: submitStatus,
      })
      try {
        await web.chat.update({
          channel: channelID,
          ts: messageTs,
          text: "Session no longer active — approval discarded.",
          blocks: resolvedBlocks("*Session no longer active — approval discarded.*"),
        })
      } catch {
        // best-effort
      }
      return
    }
    pendingPermissions.delete(permissionID)
    await log("info", "approval submitted from Slack", { permissionID, sessionID, response })

    const label =
      response === "reject"
        ? "Rejected from Slack."
        : response === "always"
          ? "Always allowed from Slack."
          : "Approved once from Slack."
    try {
      await web.chat.update({
        channel: channelID,
        ts: messageTs,
        text: label,
        blocks: resolvedBlocks(`*${label}*`),
      })
    } catch {
      // best-effort
    }
  }

  async function onSlackMessage(body: {
    event?: {
      type?: string
      subtype?: string
      bot_id?: string
      user?: string
      text?: string
      ts?: string
      thread_ts?: string
    }
  }): Promise<void> {
    const event = body.event
    if (!event || event.type !== "message") return
    if (event.bot_id || event.subtype) return
    if (!event.thread_ts || event.thread_ts === event.ts) return

    const sessionID = sessions.sessionForThread(event.thread_ts)
    if (!sessionID || !event.user) return

    if (!authorized(event.user)) {
      await log("warn", "ignored reply from unauthorized user", { user: event.user })
      return
    }

    const text = (event.text ?? "").trim()
    if (!text) return

    await log("info", "Slack reply received", { sessionID, user: event.user, chars: text.length })

    if (text === "!abort" || text === "abort") {
      try {
        await client.session.abort({ path: { id: sessionID } })
        await log("info", "abort requested from Slack", { sessionID })
      } catch (error) {
        await log("error", "failed to abort from Slack", { error: String(error) })
      }
      return
    }

    const pendingQuestion = [...pendingQuestions.values()].find(
      (question) => question.sessionID === sessionID,
    )
    if (pendingQuestion) {
      const index = pendingQuestion.info.questions.findIndex(
        (_, i) => (pendingQuestion.selected[i] ?? []).length === 0,
      )
      if (index >= 0) {
        pendingQuestion.selected[index] = [text]
        const allSingleSelect = pendingQuestion.info.questions.every((q) => !q.multiple)
        const complete = pendingQuestion.info.questions.every(
          (_, i) => (pendingQuestion.selected[i] ?? []).length > 0,
        )
        await log("info", "Slack reply answered a question", {
          sessionID,
          requestID: pendingQuestion.info.id,
        })
        if (allSingleSelect && complete) {
          await submitQuestion(pendingQuestion.info.id)
        } else {
          await renderQuestion(pendingQuestion.info.id)
        }
        return
      }
    }

    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
      await markActive(sessionID)
      await log("info", "injected Slack reply", { sessionID })
    } catch (error) {
      await log("error", "failed to inject Slack reply", { error: String(error) })
    }
  }

  /**
   * Handles the `/s` slash command (Socket Mode `slash_commands` event).
   * (`/status` is reserved by Slack, so the registered command is `/s`.)
   * Replies ephemerally with the target session's title, pending
   * approval/question state, and its last few activity lines — redacted and
   * truncated by the shared helpers, so no host detail leaks.
   */
  async function onSlashCommand(body: SlashCommandBody): Promise<void> {
    const userID = body.user_id
    const channelID = body.channel_id
    if (!userID || !channelID) return

    if (!authorized(userID)) {
      await log("warn", "ignored /s from unauthorized user", { user: userID })
      await replyEphemeral(channelID, userID, "You are not allowed to use `/s`.")
      return
    }

    const query = (body.text ?? "").trim()
    const lowerQuery = query.toLowerCase()

    // Resolve the target session: an explicit query matches a session ID or
    // title substring; otherwise fall back to the most recent session whose
    // thread lives in the channel the command was invoked from.
    let targetID: string | undefined
    let ref: SessionRef | undefined
    if (lowerQuery) {
      let latest: [string, SessionRef] | null = null
      for (const [id, candidate] of sessions.entries()) {
        if (id.toLowerCase() !== lowerQuery && !candidate.title.toLowerCase().includes(lowerQuery)) continue
        if (!latest || candidate.createdAt > latest[1].createdAt) latest = [id, candidate]
      }
      if (latest) [targetID, ref] = latest
    } else {
      let latest: [string, SessionRef] | null = null
      for (const [id, candidate] of sessions.entries()) {
        if (candidate.channel !== channelID) continue
        if (!latest || candidate.createdAt > latest[1].createdAt) latest = [id, candidate]
      }
      if (latest) [targetID, ref] = latest
    }

    if (!targetID || !ref) {
      const hint = query
        ? `No session matching \`${escapeMrkdwn(truncate(redactHostInfo(query), 60))}\` found.`
        : "No sessions in this channel yet."
      await replyEphemeral(channelID, userID, hint)
      return
    }

    const pendingApproval = [...pendingPermissions.values()].some(
      (pending) => pending.sessionID === targetID,
    )
    const pendingQuestion = [...pendingQuestions.values()].some(
      (pending) => pending.sessionID === targetID,
    )

    // Last few messages with text, newest last — the same tail the cards use.
    const activity: StatusActivity[] = []
    try {
      const res = await client.session.messages({ path: { id: targetID } })
      const messages = res.data ?? []
      const recent: StatusActivity[] = []
      for (let i = messages.length - 1; i >= 0 && recent.length < 3; i--) {
        const message = messages[i]
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n")
          .trim()
        if (text) recent.unshift({ role: message.info.role, text })
      }
      activity.push(...recent)
    } catch {
      // best-effort: the reply below still carries title and pending state
    }

    await replyEphemeral(
      channelID,
      userID,
      sessionStatusText(ref.title, { approval: pendingApproval, question: pendingQuestion }, activity),
    )
    await log("info", "/s served", { sessionID: targetID, user: userID })
  }

  socket.on("slack_event", async (args: { ack?: () => Promise<void>; body: unknown }) => {
    try {
      await args.ack?.()
    } catch {
      // ack failures are non-fatal
    }
    const body = args.body as { type?: string } | undefined
    if (!body) return
    try {
      if (body.type === "block_actions") {
        await onAction(body as Parameters<typeof onAction>[0])
      } else if (body.type === "event_callback") {
        await onSlackMessage(body as Parameters<typeof onSlackMessage>[0])
      } else if (body.type === "slash_commands") {
        const slash = body as SlashCommandBody
        if (slash.command === "/s") await onSlashCommand(slash)
      }
    } catch (error) {
      await log("error", "slack event handler failed", { error: String(error) })
    }
  })

  try {
    await web.auth.test()
  } catch (error) {
    await log("error", "Slack auth failed; bot token rejected", { error: String(error) })
    return null
  }

  socket.start().catch((error: unknown) => {
    void log("error", "Socket Mode connection failed", { error: String(error) })
  })
  await log("info", "Slack bridge connected", { channel: config.channel })

  return {
    onEvent,
    dispose: async () => {
      try {
        await socket.disconnect()
      } catch {
        // ignore
      }
    },
  }
}
