import type { Plugin } from "@opencode-ai/plugin";
/**
 * Bridges opencode agent sessions to Slack.
 *
 * - Creates one Slack thread per session and posts interactive approval and
 *   question cards, each with a compact, redacted context summary.
 * - Shows an in-progress loader reaction (:hourglass_flowing_sand:) on the
 *   session's root message while it works — added when the session starts or
 *   new activity arrives, and swapped for a done check mark (:white_check_mark:)
 *   when the session goes idle or is deleted; new activity after idle swaps
 *   it back.
 * - Handles the /s slash command: an ephemeral reply with the session's
 *   last few activity lines, pending approval/question state, all redacted.
 * - Lets you answer approvals and questions with buttons and inject thread
 *   replies back into the running session as prompts.
 * - Routine progress (tool runs, plans, completion summaries, errors) is not
 *   mirrored, and host-specific detail (absolute paths, hostnames, usernames)
 *   is redacted from everything posted.
 *
 * Configuration is read from the project `.env` (or process env):
 *   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL,
 *   SLACK_ALLOWED_USERS, SLACK_BRIDGE=on|off
 *
 * When the config is incomplete the plugin logs once and stays inert, so
 * opencode always starts.
 */
export declare const SlackBridge: Plugin;
