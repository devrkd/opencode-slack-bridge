import type { Plugin } from "@opencode-ai/plugin"
import { createBridge } from "./bridge"

/**
 * Bridges opencode agent sessions to Slack.
 *
 * - Creates one Slack thread per session and posts interactive approval and
 *   question cards, each with a compact, credential-redacted context summary.
 * - Shows an in-progress loader reaction (:hourglass_flowing_sand:) on the
 *   session's root message while it works — added when the session starts or
 *   new activity arrives, and swapped for a done check mark (:white_check_mark:)
 *   when the session goes idle or is deleted; new activity after idle swaps
 *   it back.
 * - Handles the /s slash command: an ephemeral reply with the session's
 *   last few activity lines, pending approval/question state, all credential-redacted.
 * - Lets you answer approvals and questions with buttons and inject thread
 *   replies back into the running session as prompts. The agent's reply to a
 *   Slack-originated prompt is mirrored back into the thread (set
 *   SLACK_REPLY_MIRROR=off to disable).
 * - Runs Slack-originated turns read-only: read-only permission kinds and
 *   clearly read-only bash commands are auto-approved, file edits and
 *   anything unrecognised are auto-denied and announced in the thread
 *   (set SLACK_READ_ONLY=off to disable and fall back to approval cards).
 * - Routine progress (tool runs, plans, completion summaries, errors) is not
 *   mirrored. Credentials are redacted from everything posted (token
 *   prefixes, JWTs, private keys, Authorization headers, credentials in
 *   URLs, KEY=value pairs with sensitive keys); paths stay readable.
 *
 * Configuration is read from the project `.env` (or process env):
 *   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL,
 *   SLACK_ALLOWED_USERS, SLACK_BRIDGE=on|off
 *
 * When the config is incomplete the plugin logs once and stays inert, so
 * opencode always starts.
 */
export const SlackBridge: Plugin = async (input) => {
  let bridge: Awaited<ReturnType<typeof createBridge>>
  try {
    bridge = await createBridge(input)
  } catch {
    return {}
  }
  if (!bridge) return {}

  return {
    event: async ({ event }) => {
      await bridge.onEvent(event as { type: string; properties: unknown })
    },
    dispose: async () => {
      await bridge.dispose()
    },
  }
}
