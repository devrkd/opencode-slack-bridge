# Slack Bridge Integration (opencode)

The [`opencode-slack-bridge`](https://www.npmjs.com/package/opencode-slack-bridge) npm package is an opencode **plugin** that bridges opencode sessions to Slack and lets you steer long agent runs from Slack — approving prompts, answering the agent's questions, and injecting replies without touching the terminal.

- **Out** — one Slack thread per session in the configured channel, used **only** for approval and question cards, each with a compact context summary. Routine progress (tool runs, plans, completion summaries, errors) is not mirrored. Credentials are redacted from everything posted — token prefixes (Slack, GitHub, OpenAI/Anthropic, AWS), JWTs, private-key blocks, Authorization headers, credentials in URLs, and `KEY=value` pairs with sensitive keys — while paths and host detail stay readable so you can follow the work. Subagent (child) sessions get a thread **lazily**, only when they need approval or input (see below). A loader reaction (`:hourglass_flowing_sand:`) on the thread's root message marks work in progress; when the session ends it is swapped for a done check mark (`:white_check_mark:`) — see [Reaction lifecycle](#reaction-lifecycle).
- **In** — interactive approval messages with **Approve once / Always / Reject** buttons, option buttons for the agent's `question` tool, thread replies injected into the running session as prompts (with the agent's reply mirrored back into the thread and the turn constrained to **read-only** execution), and `!abort` to stop a session.

The plugin auto-loads when opencode starts. If the Slack config is incomplete it logs once and stays inert, so opencode always starts.

## Implementation files

| File | Purpose |
|---|---|
| [`src/plugin.ts`](https://github.com/devrkd/opencode-slack-bridge/blob/main/src/plugin.ts) | Plugin entry point. Registers the `event` and `dispose` hooks and delegates to the bridge. |
| [`src/config.ts`](https://github.com/devrkd/opencode-slack-bridge/blob/main/src/config.ts) | Reads the project `.env`, validates the Slack variables, honours `SLACK_BRIDGE=off`. |
| [`src/bridge.ts`](https://github.com/devrkd/opencode-slack-bridge/blob/main/src/bridge.ts) | Core logic: event handling, lazy child-thread creation, Slack client wiring (Web API + Socket Mode), button actions, reply injection, stale-click and orphan-card handling. |
| [`src/format.ts`](https://github.com/devrkd/opencode-slack-bridge/blob/main/src/format.ts) | Block Kit formatting, mrkdwn escaping/truncation, normalisation of permission/question events, and credential redaction (`redactSecrets`). |
| [`src/session-map.ts`](https://github.com/devrkd/opencode-slack-bridge/blob/main/src/session-map.ts) | Persists the `sessionID → Slack thread` mapping. |
| [`package.json`](https://github.com/devrkd/opencode-slack-bridge/blob/main/package.json) | Runtime deps: `@slack/web-api`, `@slack/socket-mode`. Dev deps: `@slack/types`, `@opencode-ai/plugin`, `@opencode-ai/sdk`. |
| `.opencode/slack-bridge-state.json` | Runtime state file (session→thread map), written under the host project's `.opencode/` and not committed; a corrupt file is discarded and the bridge starts clean. |

Logging goes to opencode's app log under the service name **`slack-bridge`** (levels debug/info/warn/error).

## Configuration

The plugin reads the project `.env` **itself** (`loadDotenv` in `src/config.ts`), so the `SLACK_*` values do not need to be exported. Existing environment variables always win over file values.

| Variable | Required | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth token; must start with `xoxb-`. |
| `SLACK_APP_TOKEN` | yes | App-level token for Socket Mode; must start with `xapp-`. |
| `SLACK_CHANNEL` | yes | Channel ID (e.g. `C0123ABCD`) where per-session threads are posted. |
| `SLACK_ALLOWED_USERS` | recommended | Comma-separated Slack user IDs allowed to answer approvals. If empty, **any** member of the channel can approve agent commands (a warning is logged). |
| `SLACK_BRIDGE` | no | Set to `off` to disable the bridge without removing tokens (`off`/`false`/`0`/`no` all disable). |
| `SLACK_REPLY_MIRROR` | no | Set to `off` to stop mirroring the agent's reply back into the thread for Slack-originated prompts (`off`/`false`/`0`/`no` all disable; default on). |
| `SLACK_READ_ONLY` | no | Set to `off` to disable read-only enforcement for Slack-originated turns and fall back to approval cards for every permission (`off`/`false`/`0`/`no` all disable; default on). |

On startup the bridge:

1. Checks `SLACK_BRIDGE` and the presence/format of the three required variables. Missing or invalid config → logs `disabled: <reason>` and the plugin returns inert.
2. Verifies the bot token with `web.auth.test()`; failure → logs and disables.
3. Starts the Socket Mode client; connection failures are logged but never break the agent.

## Outbound: approvals and questions only

One Slack thread per **top-level** session, created as soon as the session starts. The thread root message is *"Session started — `<title>` / _Project: `<project name>`_"* — the working directory is reduced to its basename (the project/repo name), never the full path. The mapping is persisted in `.opencode/slack-bridge-state.json` so a plugin reload keeps posting into the same thread instead of spawning a duplicate.

Routine progress is **not** mirrored: tool runs, plan updates, completion summaries, and errors never produce Slack messages (errors are logged to the local opencode app log only). The channel receives approval and question cards — the moments a human actually needs to act — plus, for turns started from a thread reply, the agent's answer (see [Inbound](#inbound-steering-from-slack)). The only other activity on the threads is the status reaction on each root message, which marks the session busy or done without ever adding a message (see [Reaction lifecycle](#reaction-lifecycle)).

Child (subagent) sessions behave differently — see below.

| opencode event | Slack effect |
|---|---|
| `session.created` | Top-level sessions: creates the thread root message and adds the loader reaction. Child sessions: only recorded — **no thread yet**. |
| `session.updated` | Refreshes the thread root text when a session is renamed (top-level and child threads alike). |
| `todo.updated` | No Slack message (routine progress is not mirrored). |
| `tool.execute.after` | No Slack message (routine progress is not mirrored). |
| `session.idle` | No Slack message (completion summaries are not mirrored); swaps the loader reaction for the `:white_check_mark:` done reaction. If the turn was started from a Slack reply and nothing was mirrored yet, the agent's final text is posted as a fallback. |
| `session.error` | No Slack message; the error is logged locally under `slack-bridge`. |
| `message.part.updated` | Only while the turn was started from a Slack reply: each completed assistant text part is posted into the thread, secret-redacted and truncated (see [Ask the agent from the thread](#inbound-steering-from-slack)). |
| `permission.asked` / `permission.updated` | Posts an **approval card** (see below) — unless the turn is read-only (started from a Slack reply with `SLACK_READ_ONLY` on): then the request is answered automatically without a card (read-only commands/kinds approved once, everything else rejected and announced in the thread). For a child, this creates the child's thread on demand and drops a pointer notice in the parent's thread. |
| `permission.replied` | Updates the card to *"Approval resolved in terminal: `<reply>`"*. |
| `question.asked` / `question.v2.asked` | Posts a **question card** (see below). For a child, this creates the child's thread on demand and drops a pointer notice in the parent's thread. |
| `question.replied` / `question.rejected` (and v2) | Updates the card to *"Answered/Rejected elsewhere (terminal)"*. |
| `session.deleted` | Removes the session's thread mapping, resolves any pending cards it still owns, and leaves the `:white_check_mark:` done reaction on the root message (see orphan sweep below). |

All posting is **best-effort** — Slack failures are swallowed and never break the agent.

### Reaction lifecycle

Each thread's root message carries exactly one status reaction, showing where the session is in its lifecycle:

- **`session.created` / new thread** — the loader (`:hourglass_flowing_sand:`) is added when the root message is created.
- **New activity** — when an approval/question card is posted, a question is answered from Slack, or a Slack reply is injected as a prompt, the loader is restored (swapping back from the done check mark if the session had gone idle).
- **`session.idle`** — the loader is swapped for the done check mark (`:white_check_mark:`); the session is finished.
- **`session.deleted`** — the done check mark is left in place (or applied if not already there) and the local reaction state is dropped.

Reactions are **never** thread messages, so the "thread = cards only" invariant holds. The bridge tracks the applied state in memory only, so redundant Slack calls are not repeated, and `already_reacted` / `no_reaction` / `message_not_found` errors are tolerated. This needs the `reactions:write` bot scope (already in [Setup](#setup)); every reaction call is best-effort, so a missing scope degrades to no reactions rather than breaking the agent.

### Child (subagent) sessions

Sessions with a `parentID` — e.g. an Architect or Developer spawned via the Orchestrator's `task` tool — don't get a thread when they start; the bridge just remembers them.

- **Lazy threads.** The child's thread root (*"Subagent session — `<title>` (child of `<parent title>`)"*) is created only when the child first asks for approval or input — i.e. with its first approval or question card. At the same time a pointer notice (*"🛑 Subagent `<title>` is requesting approval — see its thread below."*) is posted in the parent's thread so you can find the child's thread from the parent's.
- **Cards only.** No progress is ever mirrored — for a child or otherwise. Only approval and question cards (with their context summary) post to the child's thread.

### Approval cards

For each `permission.asked`, the bridge posts an interactive message with the permission kind, the command/always patterns (credential-redacted), a compact summary of the last few lines of session context (credential-redacted), and three buttons:

- **Approve once** → submits `once` for that permission
- **Always** → submits `always`
- **Reject** → submits `reject`

Button values carry a JSON payload (`kind`, `sessionID`, `permissionID`, `response`); the action handler validates the `slackbridge` action prefix, checks the user against `SLACK_ALLOWED_USERS`, and submits via opencode's permission API. The card is then updated to *"Approved once from Slack."*, *"Always allowed from Slack."*, or *"Rejected from Slack."*.

Stale or replayed clicks are discarded: a click is only honoured if the bridge still holds the pending entry it registered for that `permissionID`/`sessionID` pair, so a click on an already-resolved card can never submit twice. If the submit itself fails, a transient failure (network/5xx) keeps the card live for a retry, while a definitive rejection (4xx — e.g. the session can no longer accept the approval) discards the card and updates it to *"Session no longer active — approval discarded."*.

### Question cards

For each `question.asked`, the bridge renders the agent's `question` tool as buttons: one button per option (multi-select toggles), **Submit answers**, and **Reject**. The card also carries a compact, credential-redacted summary of the last few lines of session context. Single-select questions auto-submit once every question has an answer; multi-select needs an explicit Submit. Thread replies can also fill in the first unanswered question (including custom answers when the question allows them). Submission posts to the opencode server's `/question/<id>/reply` endpoint; rejection posts to `/question/<id>/reject`. Option buttons carry only the question/option indexes — the bridge resolves the chosen option from its own pending state — and stale clicks on a request that is no longer pending are ignored.

## Inbound: steering from Slack

Socket Mode delivers `block_actions` (button clicks) and `event_callback` (messages). For thread replies, the bridge:

1. Ignores bot messages, message subtypes, and anything not in a known thread.
2. Checks the sender against `SLACK_ALLOWED_USERS`; unauthorized users are ignored (and a warning is logged).
3. `!abort` (or `abort`) → aborts the session via opencode's abort API.
4. Otherwise, if a question is pending for the session, the reply answers the first unanswered question (auto-submitting a fully-answered single-select question).
5. Otherwise the reply is **injected into the running session as a prompt** via `promptAsync` — it behaves exactly like a typed prompt in the terminal — and the session is marked for **reply mirroring**: every assistant text message the agent produces for that turn is posted back into the thread (escaped, and truncated like every other post; over-long replies end with an explicit _(truncated)_ marker). If the injected prompt cannot be delivered (e.g. the session has ended), an ephemeral error is shown to the sender. Mirroring stops when the turn ends (`session.idle`), and `SLACK_REPLY_MIRROR=off` disables it entirely.

### Read-only turns

A turn started from a Slack thread reply runs **read-only** by default (`SLACK_READ_ONLY=off` restores card-based approvals for everything):

- **Read-only permission kinds** (`read`, `glob`, `grep`, `list`, `task`, `webfetch`) are approved automatically.
- **Bash commands** are classified by a conservative allowlist (file reading, text search, `git` read subcommands, etc.). Recognised read-only commands — including every segment of a pipe or `&&` chain — are approved automatically; commands with redirection, command substitution, backgrounding, unrecognised programs, or anything that can mutate or reach the network are **rejected**.
- **Everything else** — `edit`, file writes, unknown permission kinds — is rejected.
- Rejections are announced in the session's thread (`✋ Read-only from Slack — denied: …`) and returned to the agent, which adapts and reports instead of mutating the workspace. Subagent sessions spawned by a read-only turn inherit the constraint.
- Approval cards are not posted for permission requests inside read-only turns; `permission.asked` for them is answered automatically.

## Setup

1. Create a Slack app at <https://api.slack.com/apps> → **From scratch**, and enable **Socket Mode** (no public request URL needed).
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `channels:read`, plus `channels:history` (public channels) **or** `groups:history` (private channels), `users:read`, `reactions:write`. Install to the workspace and copy the `xoxb-` Bot User OAuth Token.
3. **Basic Information → App-Level Tokens**: generate one with the `connections:write` scope; copy the `xapp-` token.
4. Turn on **Interactivity**, and under **Event Subscriptions** subscribe to `message.channels` (public channels) **or** `message.groups` (private channels) — matching the history scope from step 2.
5. `/invite` the app to the target channel and copy its channel ID (`C…`). Copy your member ID (`U…`) for `SLACK_ALLOWED_USERS`.
6. Fill the project's `.env`:

   ```ini
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_CHANNEL=C0123ABCD
   SLACK_ALLOWED_USERS=U0123ABCD
   ```

7. Run `opencode`. It installs the package and loads the plugin; the bridge then connects and posts a thread per session.

Set `SLACK_BRIDGE=off` to disable without removing tokens. Leave `SLACK_ALLOWED_USERS` unset at your own risk — then anyone in the channel can approve agent commands.

## Watching Slack-triggered work in the terminal

The bridge runs **inside the opencode server**, so anything Slack injects shows up the same way your own typing does.

- **Normal TUI** — run `opencode`. A Slack reply injected into a session streams live in that session's view. Switch sessions to see other threads.
- **Headless + attach** — run the server, then attach a live TUI:

  ```bash
  opencode serve --port 4096 --print-logs
  opencode attach http://127.0.0.1:4096
  ```

  `opencode web` is the same view in a browser.
- **Logs only** — `opencode serve --print-logs --log-level DEBUG` prints bridge lines (`injected Slack reply`, `approval card posted`, `session error (not posted to Slack)`) alongside opencode's loop/tool logs.

## Environment-variable notes

- The plugin reads `.env` itself, so `SLACK_*` values do not need to be exported.
- `GITHUB_TOKEN` is the opposite: it is read from the **environment** by `opencode.json` (`{env:GITHUB_TOKEN}` interpolation), so it must be exported.

## Known behaviour and limitations

- **Child (subagent) threads are lazy.** Sessions with a `parentID` get no thread until they first ask for approval or input; from then on their approval and question cards post to their own thread, reachable via the pointer notice in the parent's thread.
- **Progress is never mirrored — with one exception.** Tool runs, plan updates, completion summaries, and errors produce no Slack messages; errors are logged locally only. The channel only receives approval/question cards, their context summaries, and (since reply mirroring) the agent's reply to a prompt that was typed in a session's thread.
- **Reply mirroring is scoped to Slack-originated prompts.** Only turns started by a thread reply mirror their assistant text back; work started in the terminal stays invisible in Slack. Mirrored replies are secret-redacted and truncated to Slack's message limits. `/s` still answers without waking the agent when all you need is the recent activity.
- **Slack turns are read-only by default.** Prompts injected from a thread cannot modify the workspace: read-only commands run automatically, everything else is denied with a note in the thread. The bash allowlist is deliberately narrow (no `npm`/`node`/`curl`/`awk`/`sed`/`git` mutations) — deny is the default, and `SLACK_READ_ONLY=off` restores card-based approvals if you want full interactivity from Slack.
- **Credentials are redacted, not paths.** Token prefixes (Slack, GitHub, OpenAI/Anthropic, AWS), JWTs, private-key blocks, Authorization headers, credentials in URLs, and `KEY=value` pairs with sensitive keys are replaced with `[redacted]` before posting. Absolute paths, hostnames, and other host detail are **not** redacted — agent output stays readable, so review what the agent prints before steering it from a shared channel.
- **Stale clicks are discarded.** Approval and question buttons are only honoured while the bridge still holds the corresponding pending request; clicks on resolved or replayed cards are ignored. A failed approval submit keeps the card live on transient errors and discards it (*"Session no longer active — approval discarded."*) when opencode definitively rejects it.
- **Orphan sweep on `session.deleted`.** When a session is deleted, the bridge removes its thread mapping, leaves the `:white_check_mark:` done reaction on the root message, and resolves every pending approval/question card still registered for it — the Slack cards are updated to *"Session ended — pending request discarded."* and the pending entries are dropped so stale state can never resolve a different session.
- All Slack posts are best-effort; a failed post is silent. To diagnose, run `opencode serve --print-logs --log-level DEBUG` and look for `slack-bridge` service lines: `Slack bridge connected`, `created Slack thread`, `approval card posted`, `child approval card posted`, `question card posted`, `session error (not posted to Slack)`, `injected Slack reply`, `disabled: …`, `Socket Mode connection failed`, `ignored approval from unauthorized user …`, `ignored stale approval`, `ignored stale question action`, `orphaned card resolved`.
- The session→thread map persists in `.opencode/slack-bridge-state.json` (not committed). If it is corrupted it is discarded and the bridge starts clean, which can result in a duplicate root message for sessions created before the restart.
