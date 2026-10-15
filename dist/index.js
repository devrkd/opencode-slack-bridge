// src/bridge.ts
import { join as join2 } from "node:path";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";

// src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function parseEnv(contents) {
  const result = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      const quoted = first === '"' && last === '"' || first === "'" && last === "'";
      if (quoted) value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}
function loadDotenv(directory) {
  const file = join(directory, ".env");
  if (!existsSync(file)) return;
  let parsed;
  try {
    parsed = parseEnv(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === void 0) process.env[key] = value;
  }
}
function isOff(value) {
  if (value === void 0) return false;
  const v = value.trim().toLowerCase();
  return v === "off" || v === "false" || v === "0" || v === "no";
}
function loadConfig(directory) {
  if (isOff(process.env.SLACK_BRIDGE)) {
    return { ok: false, reason: "SLACK_BRIDGE is off" };
  }
  loadDotenv(directory);
  const botToken = (process.env.SLACK_BOT_TOKEN ?? "").trim();
  const appToken = (process.env.SLACK_APP_TOKEN ?? "").trim();
  const channel = (process.env.SLACK_CHANNEL ?? "").trim();
  const allowedUsers = (process.env.SLACK_ALLOWED_USERS ?? "").split(",").map((user) => user.trim()).filter(Boolean);
  const problems = [];
  if (!botToken) problems.push("SLACK_BOT_TOKEN");
  else if (!botToken.startsWith("xoxb-"))
    problems.push("SLACK_BOT_TOKEN (must start with xoxb-)");
  if (!appToken) problems.push("SLACK_APP_TOKEN");
  else if (!appToken.startsWith("xapp-"))
    problems.push("SLACK_APP_TOKEN (must start with xapp-)");
  if (!channel) problems.push("SLACK_CHANNEL");
  if (problems.length > 0) {
    return { ok: false, reason: `missing or invalid ${problems.join(", ")}` };
  }
  return {
    ok: true,
    config: { botToken, appToken, channel, allowedUsers, mirrorReplies: !isOff(process.env.SLACK_REPLY_MIRROR) }
  };
}

// src/session-map.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var SessionMap = class {
  refs = /* @__PURE__ */ new Map();
  file;
  constructor(file) {
    this.file = file;
    this.load();
  }
  load() {
    if (!existsSync2(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync2(this.file, "utf8"));
      for (const [id, ref] of Object.entries(parsed)) {
        if (ref && typeof ref.ts === "string" && typeof ref.channel === "string") {
          this.refs.set(id, ref);
        }
      }
    } catch {
    }
  }
  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.refs), null, 2));
      renameSync(tmp, this.file);
    } catch {
    }
  }
  get(id) {
    return this.refs.get(id);
  }
  has(id) {
    return this.refs.has(id);
  }
  set(id, ref) {
    this.refs.set(id, ref);
    this.save();
  }
  delete(id) {
    this.refs.delete(id);
    this.save();
  }
  entries() {
    return this.refs.entries();
  }
  sessionForThread(ts) {
    for (const [id, ref] of this.refs) {
      if (ref.ts === ts) return id;
    }
    return void 0;
  }
};

// src/format.ts
import { basename } from "node:path";
import { homedir } from "node:os";
function normalizePermission(raw) {
  const value = raw ?? {};
  const kind = typeof value.permission === "string" ? value.permission : "action";
  const patterns = Array.isArray(value.patterns) ? value.patterns.filter((item) => typeof item === "string") : [];
  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : {};
  const always = Array.isArray(value.always) ? value.always.filter((item) => typeof item === "string") : [];
  const command = typeof metadata.command === "string" ? metadata.command : void 0;
  const summary = patterns.length > 0 ? patterns.join(", ") : command ?? "";
  return {
    id: typeof value.id === "string" ? value.id : "",
    sessionID: typeof value.sessionID === "string" ? value.sessionID : "",
    kind,
    patterns,
    always,
    metadata,
    title: summary ? `${kind}: ${summary}` : `${kind} requires approval`
  };
}
function escapeMrkdwn(text) {
  return (text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function truncate(text, max = 280) {
  const clean = (text ?? "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}\u2026`;
}
function redactHostInfo(text) {
  const unixAbsolute = /(?<![\w./~-])\/(?:Users|home|root|private|var|tmp|etc|opt|usr|Volumes)\/[^\s"'`()<>[\]{}|;,]*/g;
  const windowsDrive = /\b[A-Za-z]:\\[^\s"'`()<>[\]{}|;,]*/g;
  const uncShare = /\\\\[^\\\s]+\\[^\s"'`()<>[\]{}|;,]*/g;
  return (text ?? "").replace(unixAbsolute, "[path]").replace(windowsDrive, "[path]").replace(uncShare, "[path]");
}
function projectName(directory) {
  const dir = (directory ?? "").trim();
  if (!dir || dir === homedir()) return "";
  return basename(dir);
}
function sessionRootText(title, directory) {
  const name = escapeMrkdwn(truncate(redactHostInfo(title) || "untitled session", 120));
  const project = projectName(directory);
  const where = project ? `
_Project: ${escapeMrkdwn(project)}_` : "";
  return `*Session started* \u2014 ${name}${where}
Approvals and replies stay in this thread.`;
}
function childSessionRootText(title, parentTitle) {
  const name = escapeMrkdwn(truncate(redactHostInfo(title) || "untitled subagent", 120));
  const parent = parentTitle ? ` _(child of ${escapeMrkdwn(truncate(redactHostInfo(parentTitle), 80))})_` : "";
  return `*Subagent session* \u2014 ${name}${parent}
Approvals and replies for this subagent stay in this thread.`;
}
function childThreadPointerText(childTitle) {
  return `\u{1F6D1} Subagent _${escapeMrkdwn(truncate(redactHostInfo(childTitle), 80))}_ is requesting approval \u2014 see its thread below.`;
}
function recentContextLines(text, maxLines = 3, maxChars = 160) {
  const clean = (text ?? "").trim();
  if (!clean) return "";
  const lines = clean.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.slice(-maxLines).map((line) => redactHostInfo(truncate(line, maxChars))).join("\n");
}
function sessionStatusText(title, pending, activity) {
  const name = escapeMrkdwn(truncate(redactHostInfo(title) || "untitled session", 120));
  const parts = [`*Session status* \u2014 ${name}`];
  if (pending.approval) parts.push("\u23F3 _Awaiting approval._");
  if (pending.question) parts.push("\u2753 _Question pending._");
  const lines = activity.map((entry) => {
    const context = recentContextLines(entry.text, 2, 200);
    return context ? `_${escapeMrkdwn(entry.role)}_:
${escapeMrkdwn(context)}` : "";
  }).filter((line) => line.length > 0);
  parts.push(lines.length > 0 ? `_Recent activity:_
${lines.join("\n")}` : "_No recent activity._");
  return parts.join("\n");
}
function permissionDetails(permission) {
  const details = [];
  const command = permission.metadata.command;
  if (typeof command === "string" && command.trim()) {
    details.push(`command: \`${escapeMrkdwn(truncate(redactHostInfo(command), 300))}\``);
  }
  if (permission.always.length > 0) {
    details.push(`always: \`${escapeMrkdwn(truncate(redactHostInfo(permission.always.join(", ")), 200))}\``);
  }
  return details;
}
function permissionText(permission) {
  return `Approval needed: ${escapeMrkdwn(truncate(redactHostInfo(permission.title), 250))}`;
}
function permissionBlocks(permission, sessionTitle, actionPrefix, valueFor, context) {
  const title = escapeMrkdwn(truncate(redactHostInfo(permission.title || "action requires approval"), 250));
  const details = permissionDetails(permission);
  const contextParts = [
    `session: _${escapeMrkdwn(truncate(redactHostInfo(sessionTitle), 80))}_`,
    `type: \`${escapeMrkdwn(permission.kind)}\``
  ];
  if (details.length > 0) contextParts.push(details.join("  \xB7  "));
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Approval needed*
${title}` }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join("\n") }]
    }
  ];
  if (context) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Recent context*
${escapeMrkdwn(truncate(redactHostInfo(context), 600))}` }
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: `${actionPrefix}:once`,
        text: { type: "plain_text", text: "Approve once" },
        style: "primary",
        value: valueFor("once")
      },
      {
        type: "button",
        action_id: `${actionPrefix}:always`,
        text: { type: "plain_text", text: "Always" },
        value: valueFor("always")
      },
      {
        type: "button",
        action_id: `${actionPrefix}:reject`,
        text: { type: "plain_text", text: "Reject" },
        style: "danger",
        value: valueFor("reject")
      }
    ]
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "You can also reply in this thread to ask the agent \u2014 its reply lands here \u2014 or send `!abort` to stop the session."
      }
    ]
  });
  return blocks;
}
function resolvedBlocks(label) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: escapeMrkdwn(label) }
    }
  ];
}
var MIRROR_MAX_CHARS = 2900;
function agentReplyText(text) {
  return truncate(redactHostInfo((text ?? "").trim()), 120);
}
function agentReplyBlocks(text) {
  const raw = (text ?? "").trim();
  const body = truncate(redactHostInfo(raw), MIRROR_MAX_CHARS);
  const suffix = raw.length > body.length ? "\n\n_(truncated)_" : "";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${escapeMrkdwn(body)}${suffix}` }
    }
  ];
}
function normalizeQuestion(raw) {
  const value = raw ?? {};
  const questions = Array.isArray(value.questions) ? value.questions.map((entry) => {
    const item = entry ?? {};
    const options = Array.isArray(item.options) ? item.options.map((opt) => {
      const o = opt ?? {};
      return { label: String(o.label ?? ""), description: String(o.description ?? "") };
    }) : [];
    return {
      question: String(item.question ?? ""),
      header: String(item.header ?? "Question"),
      options,
      multiple: item.multiple === true,
      custom: item.custom === true
    };
  }) : [];
  return {
    id: typeof value.id === "string" ? value.id : "",
    sessionID: typeof value.sessionID === "string" ? value.sessionID : "",
    questions
  };
}
function questionText(info) {
  const header = info.questions[0]?.header ?? "the agent has a question";
  return `Input needed: ${escapeMrkdwn(truncate(redactHostInfo(header), 120))}`;
}
function questionBlocks(info, sessionTitle, actionPrefix, selected, notice, context) {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Input needed* \u2014 _${escapeMrkdwn(truncate(redactHostInfo(sessionTitle), 80))}_`
      }
    }
  ];
  if (context) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Recent context*
${escapeMrkdwn(truncate(redactHostInfo(context), 600))}` }
    });
  }
  info.questions.forEach((question, index) => {
    const chosen = selected[index] ?? [];
    const header = `*Q${index + 1}. ${escapeMrkdwn(truncate(redactHostInfo(question.header), 60))}*`;
    const body = escapeMrkdwn(truncate(redactHostInfo(question.question), 500));
    const hints = [];
    if (question.multiple) hints.push("_Select one or more, then Submit._");
    if (question.custom) hints.push("_Or reply in the thread with your own answer._");
    const hint = hints.length > 0 ? `
${hints.join(" ")}` : "";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${header}
${body}${hint}` } });
    if (question.options.length > 0) {
      const elements = question.options.map((option, optionIndex) => {
        const button = {
          type: "button",
          action_id: `${actionPrefix}:qopt:${index}:${optionIndex}`,
          text: { type: "plain_text", text: truncate(redactHostInfo(option.label || option.description), 75) },
          value: JSON.stringify({
            kind: "qopt",
            requestID: info.id,
            sessionID: info.sessionID,
            index,
            optionIndex
          })
        };
        if (chosen.includes(option.label)) button.style = "primary";
        return button;
      });
      blocks.push({ type: "actions", elements });
    }
  });
  if (notice) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(notice) }] });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: `${actionPrefix}:qsubmit`,
        text: { type: "plain_text", text: "Submit answers" },
        style: "primary",
        value: JSON.stringify({ kind: "qsubmit", requestID: info.id, sessionID: info.sessionID })
      },
      {
        type: "button",
        action_id: `${actionPrefix}:qreject`,
        text: { type: "plain_text", text: "Reject" },
        style: "danger",
        value: JSON.stringify({ kind: "qreject", requestID: info.id, sessionID: info.sessionID })
      }
    ]
  });
  return blocks;
}

// src/bridge.ts
var SERVICE = "slack-bridge";
var ACTION_PREFIX = "slackbridge";
var LOADER_EMOJI = "hourglass_flowing_sand";
var DONE_EMOJI = "white_check_mark";
function emojiFor(state) {
  return state === "loading" ? LOADER_EMOJI : DONE_EMOJI;
}
async function createBridge(input) {
  const result = loadConfig(input.directory);
  const log = async (level, message, extra) => {
    try {
      await input.client.app.log({ body: { service: SERVICE, level, message, extra } });
    } catch {
    }
  };
  if (!result.ok) {
    await log("warn", `disabled: ${result.reason}`);
    return null;
  }
  const config = result.config;
  const client = input.client;
  const web = new WebClient(config.botToken);
  const socket = new SocketModeClient({ appToken: config.appToken });
  const sessions = new SessionMap(join2(input.directory, ".opencode", "slack-bridge-state.json"));
  const childSessions = /* @__PURE__ */ new Set();
  const threadLocks = /* @__PURE__ */ new Map();
  const pendingPermissions = /* @__PURE__ */ new Map();
  const pendingQuestions = /* @__PURE__ */ new Map();
  const mirroring = /* @__PURE__ */ new Map();
  const statusReactions = /* @__PURE__ */ new Map();
  const serverUrl = input.serverUrl;
  if (config.allowedUsers.length === 0) {
    await log("warn", "SLACK_ALLOWED_USERS is empty; any member of the channel can answer approvals");
  }
  async function resolveParentTitle(parentID) {
    try {
      const parent = await client.session.get({ path: { id: parentID } });
      return parent.data?.title ?? "";
    } catch {
      return "";
    }
  }
  async function ensureThread(sessionID) {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const inflight = threadLocks.get(sessionID);
    if (inflight) return inflight;
    const task = (async () => {
      let info;
      try {
        const res = await client.session.get({ path: { id: sessionID } });
        info = res.data;
      } catch {
        return null;
      }
      if (!info) return null;
      if (info.parentID) childSessions.add(sessionID);
      const isChild = info.parentID !== void 0;
      const parentTitle = info.parentID ? await resolveParentTitle(info.parentID) : "";
      const title = info.title || "untitled session";
      const rootText = isChild ? childSessionRootText(title, parentTitle) : sessionRootText(title, info.directory);
      try {
        const posted = await web.chat.postMessage({
          channel: config.channel,
          text: rootText,
          mrkdwn: true
        });
        if (!posted.ts) return null;
        const ref = {
          channel: config.channel,
          ts: posted.ts,
          title,
          createdAt: Date.now(),
          ...info.parentID ? { parentID: info.parentID } : {}
        };
        sessions.set(sessionID, ref);
        await setStatusReaction(sessionID, ref, "loading");
        await log("info", "created Slack thread", {
          sessionID,
          ts: ref.ts,
          title,
          ...isChild ? { child: true, parentID: info.parentID } : {}
        });
        return ref;
      } catch {
        return null;
      }
    })();
    threadLocks.set(sessionID, task);
    try {
      return await task;
    } finally {
      threadLocks.delete(sessionID);
    }
  }
  async function postThread(ref, text) {
    try {
      await web.chat.postMessage({
        channel: ref.channel,
        thread_ts: ref.ts,
        text,
        mrkdwn: true
      });
    } catch {
    }
  }
  async function postThreadBlocks(ref, text, blocks) {
    try {
      await web.chat.postMessage({
        channel: ref.channel,
        thread_ts: ref.ts,
        text,
        blocks
      });
    } catch {
    }
  }
  function isReactionNoop(error, codes) {
    const dataError = error.data?.error;
    const message = describeError(error);
    return codes.some((code) => dataError === code || message.includes(code));
  }
  async function setStatusReaction(sessionID, ref, next) {
    if (!ref.ts) return;
    const current = statusReactions.get(sessionID);
    if (current === next) return;
    if (current) {
      try {
        await web.reactions.remove({ channel: ref.channel, timestamp: ref.ts, name: emojiFor(current) });
      } catch (error) {
        if (!isReactionNoop(error, ["no_reaction", "message_not_found"])) return;
      }
    }
    try {
      await web.reactions.add({ channel: ref.channel, timestamp: ref.ts, name: emojiFor(next) });
    } catch (error) {
      if (!isReactionNoop(error, ["already_reacted", "message_not_found"])) return;
    }
    statusReactions.set(sessionID, next);
  }
  async function markActive(sessionID) {
    const ref = sessions.get(sessionID);
    if (!ref) return;
    await setStatusReaction(sessionID, ref, "loading");
  }
  async function replyEphemeral(channel, user, text) {
    try {
      await web.chat.postEphemeral({ channel, user, text });
    } catch {
    }
  }
  async function lastAssistantText(sessionID) {
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const messages = res.data ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.info.role !== "assistant") continue;
        const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
        if (text) return text;
      }
    } catch {
    }
    return "";
  }
  async function messageRole(sessionID, messageID) {
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      return (res.data ?? []).find((message) => message.info.id === messageID)?.info.role;
    } catch {
      return void 0;
    }
  }
  async function onPartUpdated(part) {
    if (!part || typeof part !== "object") return;
    const p = part;
    if (p.type !== "text" || !p.sessionID || !p.id || !p.messageID) return;
    if (p.synthetic || p.ignored) return;
    if (!p.time?.end) return;
    const state = mirroring.get(p.sessionID);
    if (!state || state.postedParts.has(p.id)) return;
    const text = (p.text ?? "").trim();
    if (!text) return;
    if (await messageRole(p.sessionID, p.messageID) !== "assistant") return;
    const ref = sessions.get(p.sessionID);
    if (!ref) return;
    state.postedParts.add(p.id);
    state.postedAny = true;
    await postThreadBlocks(ref, agentReplyText(text), agentReplyBlocks(text));
    await log("info", "agent reply mirrored to Slack", { sessionID: p.sessionID, messageID: p.messageID });
  }
  async function flushMirrorOnIdle(sessionID) {
    const state = mirroring.get(sessionID);
    if (!state) return;
    mirroring.delete(sessionID);
    if (state.postedAny) return;
    const ref = sessions.get(sessionID);
    if (!ref) return;
    const text = await lastAssistantText(sessionID);
    if (!text) return;
    await postThreadBlocks(ref, agentReplyText(text), agentReplyBlocks(text));
    await log("info", "agent reply mirrored to Slack (idle fallback)", { sessionID });
  }
  function permissionValue(permission, action) {
    return JSON.stringify({
      kind: "permission",
      sessionID: permission.sessionID,
      permissionID: permission.id,
      response: action
    });
  }
  function describeError(error) {
    if (error instanceof Error) return error.message;
    const data = error.data;
    if (data && typeof data.message === "string") return data.message;
    const name = error.name;
    if (typeof name === "string") return name;
    return String(error);
  }
  async function onPermission(permission) {
    if (!permission.id || !permission.sessionID) return;
    const hadThread = sessions.has(permission.sessionID);
    const ref = await ensureThread(permission.sessionID);
    if (!ref) return;
    await markActive(permission.sessionID);
    if (!hadThread && ref.parentID) {
      const parent = sessions.get(ref.parentID);
      if (parent) {
        await postThread(parent, childThreadPointerText(ref.title));
        await log("info", "child thread pointer posted", {
          parentID: ref.parentID,
          childSessionID: permission.sessionID
        });
      }
    }
    const context = recentContextLines(await lastAssistantText(permission.sessionID));
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
          context
        )
      });
      if (posted.ts) {
        pendingPermissions.set(permission.id, {
          channel: ref.channel,
          ts: posted.ts,
          sessionID: permission.sessionID
        });
        await log("info", ref.parentID ? "child approval card posted" : "approval card posted", {
          permissionID: permission.id,
          sessionID: permission.sessionID,
          ...ref.parentID ? { parentID: ref.parentID } : {}
        });
      }
    } catch {
    }
  }
  async function onPermissionReplied(props) {
    const pending = pendingPermissions.get(props.requestID);
    if (!pending) return;
    pendingPermissions.delete(props.requestID);
    await log("info", "approval resolved elsewhere", {
      requestID: props.requestID,
      reply: props.reply
    });
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: `Approval resolved in terminal: ${props.reply}`,
        blocks: resolvedBlocks(`Approval resolved in terminal: \`${props.reply}\``)
      });
    } catch {
    }
  }
  async function renderQuestion(requestID, notice) {
    const pending = pendingQuestions.get(requestID);
    if (!pending) return;
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
          notice
        )
      });
    } catch {
    }
  }
  async function replyQuestion(requestID, answers) {
    try {
      const url = new URL(`/question/${requestID}/reply`, serverUrl);
      url.searchParams.set("directory", input.directory);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers })
      });
      if (!response.ok) {
        await log("error", "question reply failed", { requestID, status: response.status });
        return false;
      }
      return true;
    } catch (error) {
      await log("error", "question reply error", { requestID, error: String(error) });
      return false;
    }
  }
  async function submitQuestion(requestID) {
    const pending = pendingQuestions.get(requestID);
    if (!pending) {
      await log("warn", "ignored stale question action", { requestID });
      return;
    }
    const answers = pending.info.questions.map((_, index) => pending.selected[index] ?? []);
    if (answers.some((answer) => answer.length === 0)) {
      await renderQuestion(requestID, "Answer every question before submitting.");
      return;
    }
    const ok = await replyQuestion(requestID, answers);
    if (!ok) return;
    pendingQuestions.delete(requestID);
    await markActive(pending.sessionID);
    await log("info", "question answered from Slack", { requestID });
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: "Answered from Slack.",
        blocks: resolvedBlocks("*Answered from Slack.*")
      });
    } catch {
    }
  }
  async function rejectQuestion(requestID) {
    const pending = pendingQuestions.get(requestID);
    if (!pending) {
      await log("warn", "ignored stale question action", { requestID });
      return;
    }
    try {
      const url = new URL(`/question/${requestID}/reject`, serverUrl);
      url.searchParams.set("directory", input.directory);
      await fetch(url, { method: "POST" });
    } catch (error) {
      await log("error", "question reject error", { requestID, error: String(error) });
    }
    pendingQuestions.delete(requestID);
    await log("info", "question rejected from Slack", { requestID });
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: "Rejected from Slack.",
        blocks: resolvedBlocks("*Rejected from Slack.*")
      });
    } catch {
    }
  }
  async function onQuestion(info) {
    if (!info.id || !info.sessionID || info.questions.length === 0) return;
    const hadThread = sessions.has(info.sessionID);
    const ref = await ensureThread(info.sessionID);
    if (!ref) return;
    await markActive(info.sessionID);
    if (!hadThread && ref.parentID) {
      const parent = sessions.get(ref.parentID);
      if (parent) {
        await postThread(parent, childThreadPointerText(ref.title));
        await log("info", "child thread pointer posted", {
          parentID: ref.parentID,
          childSessionID: info.sessionID
        });
      }
    }
    const context = recentContextLines(await lastAssistantText(info.sessionID));
    const selected = info.questions.map(() => []);
    try {
      const posted = await web.chat.postMessage({
        channel: ref.channel,
        thread_ts: ref.ts,
        text: questionText(info),
        blocks: questionBlocks(info, ref.title, ACTION_PREFIX, selected, void 0, context)
      });
      if (!posted.ts) return;
      pendingQuestions.set(info.id, {
        channel: ref.channel,
        ts: posted.ts,
        sessionID: info.sessionID,
        info,
        selected
      });
      await log("info", "question card posted", { requestID: info.id, sessionID: info.sessionID });
    } catch {
    }
  }
  async function onQuestionResolved(requestID, label) {
    const pending = pendingQuestions.get(requestID);
    if (!pending) return;
    pendingQuestions.delete(requestID);
    await log("info", "question resolved elsewhere", { requestID, label });
    try {
      await web.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: label,
        blocks: resolvedBlocks(`*${label}*`)
      });
    } catch {
    }
  }
  async function resolvePendingForSession(sessionID, label) {
    for (const [id, pending] of [...pendingPermissions]) {
      if (pending.sessionID !== sessionID) continue;
      pendingPermissions.delete(id);
      await log("info", "orphaned card resolved", {
        sessionID,
        label,
        kind: "permission",
        permissionID: id
      });
      try {
        await web.chat.update({
          channel: pending.channel,
          ts: pending.ts,
          text: label,
          blocks: resolvedBlocks(`*${label}*`)
        });
      } catch {
      }
    }
    for (const [id, pending] of [...pendingQuestions]) {
      if (pending.sessionID !== sessionID) continue;
      pendingQuestions.delete(id);
      await log("info", "orphaned card resolved", {
        sessionID,
        label,
        kind: "question",
        requestID: id
      });
      try {
        await web.chat.update({
          channel: pending.channel,
          ts: pending.ts,
          text: label,
          blocks: resolvedBlocks(`*${label}*`)
        });
      } catch {
      }
    }
  }
  async function onEvent(event) {
    switch (event.type) {
      case "session.created": {
        const info = event.properties.info;
        if (info.parentID) {
          childSessions.add(info.id);
          return;
        }
        await ensureThread(info.id);
        return;
      }
      case "session.updated": {
        const info = event.properties.info;
        if (info.parentID) childSessions.add(info.id);
        const ref = sessions.get(info.id);
        if (!ref) {
          if (info.parentID) return;
          await ensureThread(info.id);
          return;
        }
        if (info.title && info.title !== ref.title) {
          ref.title = info.title;
          sessions.set(info.id, ref);
          const rootText = ref.parentID ? childSessionRootText(info.title, await resolveParentTitle(ref.parentID)) : sessionRootText(info.title, info.directory);
          try {
            await web.chat.update({
              channel: ref.channel,
              ts: ref.ts,
              text: rootText
            });
          } catch {
          }
        }
        return;
      }
      case "session.idle": {
        const { sessionID } = event.properties;
        if (sessionID) {
          const ref = sessions.get(sessionID);
          if (ref) await setStatusReaction(sessionID, ref, "done");
          await flushMirrorOnIdle(sessionID);
        }
        return;
      }
      case "session.error": {
        const { sessionID, error } = event.properties;
        if (!sessionID) return;
        await log("error", "session error (not posted to Slack)", {
          sessionID,
          error: describeError(error)
        });
        return;
      }
      case "todo.updated": {
        return;
      }
      case "permission.asked":
      case "permission.updated": {
        await onPermission(normalizePermission(event.properties));
        return;
      }
      case "permission.replied": {
        await onPermissionReplied(
          event.properties
        );
        return;
      }
      case "question.asked":
      case "question.v2.asked": {
        await onQuestion(normalizeQuestion(event.properties));
        return;
      }
      case "question.replied":
      case "question.v2.replied": {
        await onQuestionResolved(
          event.properties.requestID ?? "",
          "Answered elsewhere (_terminal_)."
        );
        return;
      }
      case "question.rejected":
      case "question.v2.rejected": {
        await onQuestionResolved(
          event.properties.requestID ?? "",
          "Rejected elsewhere (_terminal_)."
        );
        return;
      }
      case "message.part.updated": {
        const { part } = event.properties;
        await onPartUpdated(part);
        return;
      }
      case "session.deleted": {
        const info = event.properties;
        const sessionID = info.info?.id;
        if (!sessionID) return;
        const ref = sessions.get(sessionID);
        childSessions.delete(sessionID);
        sessions.delete(sessionID);
        mirroring.delete(sessionID);
        if (ref) await setStatusReaction(sessionID, ref, "done");
        statusReactions.delete(sessionID);
        await resolvePendingForSession(sessionID, "Session ended \u2014 pending request discarded.");
        return;
      }
      default:
        return;
    }
  }
  function authorized(userID) {
    if (!userID) return false;
    if (config.allowedUsers.length === 0) return true;
    return config.allowedUsers.includes(userID);
  }
  async function onAction(body) {
    const action = body.actions?.[0];
    if (!action?.action_id || !action.action_id.startsWith(ACTION_PREFIX)) return;
    const channelID = body.channel?.id;
    const messageTs = body.message?.ts;
    if (!channelID || !messageTs) return;
    if (!authorized(body.user?.id)) {
      await log("warn", `ignored approval from unauthorized user ${body.user?.id ?? "unknown"}`);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(action.value ?? "{}");
    } catch {
      return;
    }
    const kind = typeof payload.kind === "string" ? payload.kind : "permission";
    if (kind === "qopt") {
      const requestID = String(payload.requestID ?? "");
      const pending = pendingQuestions.get(requestID);
      if (!pending) {
        await log("warn", "ignored stale question action", {
          requestID,
          user: body.user?.id
        });
        return;
      }
      const index = Number(payload.index);
      const optionIndex = Number(payload.optionIndex);
      if (!Number.isInteger(index) || !Number.isInteger(optionIndex)) return;
      const question = pending.info.questions[index];
      const label2 = question?.options[optionIndex]?.label;
      if (!question || !label2) return;
      const current = pending.selected[index] ?? [];
      if (question.multiple) {
        pending.selected[index] = current.includes(label2) ? current.filter((item) => item !== label2) : [...current, label2];
      } else {
        pending.selected[index] = [label2];
      }
      const allSingleSelect = pending.info.questions.every((question2) => !question2.multiple);
      const complete = pending.info.questions.every(
        (_, i) => (pending.selected[i] ?? []).length > 0
      );
      if (allSingleSelect && complete) {
        await submitQuestion(requestID);
      } else {
        await renderQuestion(requestID);
      }
      return;
    }
    if (kind === "qsubmit") {
      await submitQuestion(String(payload.requestID ?? ""));
      return;
    }
    if (kind === "qreject") {
      await rejectQuestion(String(payload.requestID ?? ""));
      return;
    }
    const sessionID = String(payload.sessionID ?? "");
    const permissionID = String(payload.permissionID ?? "");
    const response = payload.response;
    if (!sessionID || !permissionID || !response) return;
    const pendingPermission = pendingPermissions.get(permissionID);
    if (!pendingPermission || pendingPermission.sessionID !== sessionID) {
      await log("warn", "ignored stale approval", {
        permissionID,
        sessionID,
        user: body.user?.id
      });
      return;
    }
    let rejected = false;
    let submitStatus;
    let submitError;
    try {
      const result2 = await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID },
        body: { response }
      });
      if (result2.error) {
        rejected = true;
        submitStatus = result2.response.status;
        submitError = result2.error;
      }
    } catch (error) {
      rejected = true;
      submitError = error;
      submitStatus = error.cause?.status;
    }
    if (rejected) {
      const deadSession = submitStatus !== void 0 && submitStatus >= 400 && submitStatus < 500;
      if (!deadSession) {
        await log("warn", "approval submit failed; card left live", {
          permissionID,
          sessionID,
          error: describeError(submitError),
          status: submitStatus
        });
        return;
      }
      pendingPermissions.delete(permissionID);
      await log("warn", "approval discarded: session inactive", {
        permissionID,
        sessionID,
        error: describeError(submitError),
        status: submitStatus
      });
      try {
        await web.chat.update({
          channel: channelID,
          ts: messageTs,
          text: "Session no longer active \u2014 approval discarded.",
          blocks: resolvedBlocks("*Session no longer active \u2014 approval discarded.*")
        });
      } catch {
      }
      return;
    }
    pendingPermissions.delete(permissionID);
    await log("info", "approval submitted from Slack", { permissionID, sessionID, response });
    const label = response === "reject" ? "Rejected from Slack." : response === "always" ? "Always allowed from Slack." : "Approved once from Slack.";
    try {
      await web.chat.update({
        channel: channelID,
        ts: messageTs,
        text: label,
        blocks: resolvedBlocks(`*${label}*`)
      });
    } catch {
    }
  }
  async function onSlackMessage(body) {
    const event = body.event;
    if (!event || event.type !== "message") return;
    if (event.bot_id || event.subtype) return;
    if (!event.thread_ts || event.thread_ts === event.ts) return;
    const sessionID = sessions.sessionForThread(event.thread_ts);
    if (!sessionID || !event.user) return;
    if (!authorized(event.user)) {
      await log("warn", "ignored reply from unauthorized user", { user: event.user });
      return;
    }
    const text = (event.text ?? "").trim();
    if (!text) return;
    await log("info", "Slack reply received", { sessionID, user: event.user, chars: text.length });
    if (text === "!abort" || text === "abort") {
      try {
        await client.session.abort({ path: { id: sessionID } });
        await log("info", "abort requested from Slack", { sessionID });
      } catch (error) {
        await log("error", "failed to abort from Slack", { error: String(error) });
      }
      return;
    }
    const pendingQuestion = [...pendingQuestions.values()].find(
      (question) => question.sessionID === sessionID
    );
    if (pendingQuestion) {
      const index = pendingQuestion.info.questions.findIndex(
        (_, i) => (pendingQuestion.selected[i] ?? []).length === 0
      );
      if (index >= 0) {
        pendingQuestion.selected[index] = [text];
        const allSingleSelect = pendingQuestion.info.questions.every((q) => !q.multiple);
        const complete = pendingQuestion.info.questions.every(
          (_, i) => (pendingQuestion.selected[i] ?? []).length > 0
        );
        await log("info", "Slack reply answered a question", {
          sessionID,
          requestID: pendingQuestion.info.id
        });
        if (allSingleSelect && complete) {
          await submitQuestion(pendingQuestion.info.id);
        } else {
          await renderQuestion(pendingQuestion.info.id);
        }
        return;
      }
    }
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] }
      });
      await markActive(sessionID);
      if (config.mirrorReplies && sessions.has(sessionID)) {
        mirroring.set(sessionID, { postedParts: /* @__PURE__ */ new Set(), postedAny: false });
      }
      await log("info", "injected Slack reply", { sessionID, mirror: mirroring.has(sessionID) });
    } catch (error) {
      await log("error", "failed to inject Slack reply", { error: String(error) });
      if (event.channel && event.user) {
        await replyEphemeral(
          event.channel,
          event.user,
          "Could not reach the session \u2014 it may have ended. The message was not delivered."
        );
      }
    }
  }
  async function onSlashCommand(body) {
    const userID = body.user_id;
    const channelID = body.channel_id;
    if (!userID || !channelID) return;
    if (!authorized(userID)) {
      await log("warn", "ignored /s from unauthorized user", { user: userID });
      await replyEphemeral(channelID, userID, "You are not allowed to use `/s`.");
      return;
    }
    const query = (body.text ?? "").trim();
    const lowerQuery = query.toLowerCase();
    let targetID;
    let ref;
    if (lowerQuery) {
      let latest = null;
      for (const [id, candidate] of sessions.entries()) {
        if (id.toLowerCase() !== lowerQuery && !candidate.title.toLowerCase().includes(lowerQuery)) continue;
        if (!latest || candidate.createdAt > latest[1].createdAt) latest = [id, candidate];
      }
      if (latest) [targetID, ref] = latest;
    } else {
      let latest = null;
      for (const [id, candidate] of sessions.entries()) {
        if (candidate.channel !== channelID) continue;
        if (!latest || candidate.createdAt > latest[1].createdAt) latest = [id, candidate];
      }
      if (latest) [targetID, ref] = latest;
    }
    if (!targetID || !ref) {
      const hint = query ? `No session matching \`${escapeMrkdwn(truncate(redactHostInfo(query), 60))}\` found.` : "No sessions in this channel yet.";
      await replyEphemeral(channelID, userID, hint);
      return;
    }
    const pendingApproval = [...pendingPermissions.values()].some(
      (pending) => pending.sessionID === targetID
    );
    const pendingQuestion = [...pendingQuestions.values()].some(
      (pending) => pending.sessionID === targetID
    );
    const activity = [];
    try {
      const res = await client.session.messages({ path: { id: targetID } });
      const messages = res.data ?? [];
      const recent = [];
      for (let i = messages.length - 1; i >= 0 && recent.length < 3; i--) {
        const message = messages[i];
        const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
        if (text) recent.unshift({ role: message.info.role, text });
      }
      activity.push(...recent);
    } catch {
    }
    await replyEphemeral(
      channelID,
      userID,
      sessionStatusText(ref.title, { approval: pendingApproval, question: pendingQuestion }, activity)
    );
    await log("info", "/s served", { sessionID: targetID, user: userID });
  }
  socket.on("slack_event", async (args) => {
    try {
      await args.ack?.();
    } catch {
    }
    const body = args.body;
    if (!body) return;
    try {
      if (body.type === "block_actions") {
        await onAction(body);
      } else if (body.type === "event_callback") {
        await onSlackMessage(body);
      } else if (body.type === "slash_commands") {
        const slash = body;
        if (slash.command === "/s") await onSlashCommand(slash);
      }
    } catch (error) {
      await log("error", "slack event handler failed", { error: String(error) });
    }
  });
  try {
    await web.auth.test();
  } catch (error) {
    await log("error", "Slack auth failed; bot token rejected", { error: String(error) });
    return null;
  }
  socket.start().catch((error) => {
    void log("error", "Socket Mode connection failed", { error: String(error) });
  });
  await log("info", "Slack bridge connected", { channel: config.channel });
  return {
    onEvent,
    dispose: async () => {
      try {
        await socket.disconnect();
      } catch {
      }
    }
  };
}

// src/plugin.ts
var SlackBridge = async (input) => {
  let bridge;
  try {
    bridge = await createBridge(input);
  } catch {
    return {};
  }
  if (!bridge) return {};
  return {
    event: async ({ event }) => {
      await bridge.onEvent(event);
    },
    dispose: async () => {
      await bridge.dispose();
    }
  };
};
export {
  SlackBridge
};
