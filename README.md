# opencode-slack-bridge

Bridge [opencode](https://opencode.ai) agent sessions to Slack: approve permissions and answer questions from Slack, steer long runs from your phone, and watch progress via status reactions — without touching the terminal.

Each session gets one Slack thread, used **only** for the moments a human needs to act. Routine progress (tool runs, plans, completion summaries, errors) is never mirrored, and host-specific detail (absolute paths, hostnames, usernames) is redacted from everything posted. If the Slack config is incomplete the plugin logs once and stays inert, so opencode always starts.

## Install

Add the plugin to your project's `opencode.json`:

```json
{
  "plugin": ["opencode-slack-bridge"]
}
```

opencode installs the package and loads the self-contained ESM bundle (`dist/index.js`) — nothing else to build or wire up.

## What you get

- **Approval cards** — permission prompts post to Slack as interactive messages with **Approve once / Always / Reject** buttons.
- **Question cards** — the agent's `question` tool options render as buttons: single-select auto-submits when every question is answered; multi-select uses toggles plus **Submit answers**.
- **Reply injection** — replying in a session's thread answers a pending question first if one exists; otherwise the reply is injected into the running session as a prompt. `!abort` (or `abort`) stops the session.
- **Status reactions** — the thread root message carries a loader (`:hourglass_flowing_sand:`) while the session works, swapped for a done check mark (`:white_check_mark:`) when it goes idle or is deleted; new activity swaps it back.
- **`/s` status command** — `/s` replies ephemerally with the target session's title, pending approval/question state, and its last few activity lines, all redacted; `/s <text>` matches a session ID or title.
- **Redaction** — host-specific detail never reaches Slack: paths, hostnames, usernames, and raw permission metadata are redacted or omitted from cards and summaries.
- **Subagent (child) sessions** — child sessions get a thread lazily, only when they first need approval or input; a pointer notice lands in the parent's thread so you can find it.

## Setup

1. Create a Slack app at <https://api.slack.com/apps> and enable **Socket Mode** (no public request URL needed).
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `channels:read`, plus `channels:history` (public channels) or `groups:history` (private channels), `users:read`, `reactions:write`, `commands`. Install the app to your workspace and copy the `xoxb-` Bot User OAuth Token.
3. **Basic Information → App-Level Tokens**: generate a token with the `connections:write` scope; copy the `xapp-` token.
4. Turn on **Interactivity** (for the buttons), and under **Event Subscriptions** subscribe to `message.channels` (public) or `message.groups` (private) — matching the history scope from step 2.
5. **Features → Slash Commands**: create the command `/s` (Slack reserves `/status`) and leave the Request URL blank — Socket Mode delivers invocations over the existing socket. Reinstall the app so the new scope and slash command apply.
6. `/invite` the app to the target channel, copy its channel ID (`C…`), and copy your Slack member ID (`U…`) for `SLACK_ALLOWED_USERS`.

## Configuration

The plugin reads the project `.env` itself (the directory opencode was started in), so the `SLACK_*` values do not need to be exported:

```ini
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL=C0123ABCD
SLACK_ALLOWED_USERS=U0123ABCD,U0123ABCDE
```

| Variable | Required | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth token; must start with `xoxb-`. |
| `SLACK_APP_TOKEN` | yes | App-level token for Socket Mode; must start with `xapp-`. |
| `SLACK_CHANNEL` | yes | Channel ID where per-session threads are posted. |
| `SLACK_ALLOWED_USERS` | recommended | Comma-separated Slack user IDs allowed to answer approvals and questions. If empty, any member of the channel can approve agent commands (a warning is logged). |
| `SLACK_BRIDGE` | no | Set to `off` to disable the bridge without removing tokens (`off`/`false`/`0`/`no` all disable). |

The session→thread map is persisted in `.opencode/slack-bridge-state.json` under the project directory (not committed). A corrupt state file is discarded and the bridge starts clean.

## Development

```bash
npm install
npm run build       # esbuild bundle + type declarations into dist/
npm run typecheck   # tsc --noEmit
```

Event-by-event behaviour, the reaction lifecycle, and known limitations are documented in the repo: <https://github.com/devrkd/mentat/blob/main/docs/slack-integration.md>.

## License

[MIT](LICENSE)
