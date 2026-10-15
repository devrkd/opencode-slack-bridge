import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import {
  agentReplyBlocks,
  agentReplyText,
  childSessionRootText,
  childThreadPointerText,
  escapeMrkdwn,
  normalizePermission,
  normalizeQuestion,
  permissionBlocks,
  permissionText,
  projectName,
  questionBlocks,
  questionText,
  recentContextLines,
  redactSecrets,
  resolvedBlocks,
  sessionRootText,
  sessionStatusText,
  truncate,
  type QuestionRequestInfo,
} from "../src/format"

describe("format: escapeMrkdwn", () => {
  it("escapes the three Slack mrkdwn control characters", () => {
    assert.equal(escapeMrkdwn("a & b < c > d"), "a &amp; b &lt; c &gt; d")
  })
  it("leaves normal text untouched", () => {
    assert.equal(escapeMrkdwn("plain text"), "plain text")
  })
})

describe("format: truncate", () => {
  it("returns short text unchanged (trimmed)", () => {
    assert.equal(truncate("  hello  "), "hello")
  })
  it("appends an ellipsis within the budget", () => {
    const out = truncate("x".repeat(300), 280)
    assert.equal(out.length, 280)
    assert.ok(out.endsWith("…"))
  })
  it("trims trailing whitespace before the ellipsis", () => {
    const out = truncate(`${"x".repeat(279)} y`, 280)
    assert.ok(!out.endsWith(" "))
    assert.ok(out.endsWith("…"))
  })
})

describe("format: redactSecrets (security)", () => {
  it("leaves absolute paths readable", () => {
    assert.equal(
      redactSecrets("cannot read /Users/ramesh/secret/key.txt"),
      "cannot read /Users/ramesh/secret/key.txt",
    )
    assert.equal(redactSecrets("see /home/dev/build.log for detail"), "see /home/dev/build.log for detail")
    assert.equal(redactSecrets("open C:\\Users\\dev\\file.txt now"), "open C:\\Users\\dev\\file.txt now")
  })
  it("redacts known token prefixes", () => {
    assert.equal(redactSecrets("slack xoxb-1234-abcdef-ghijkl"), "slack [redacted]")
    assert.equal(redactSecrets("gh repo ghp_0123456789abcdef0123456789abcdef"), "gh repo [redacted]")
    assert.equal(redactSecrets("key sk-proj-0123456789abcdef012345"), "key [redacted]")
  })
  it("redacts AWS keys, JWTs and authorization headers", () => {
    assert.equal(redactSecrets("aws AKIAIOSFODNN7EXAMPLE"), "aws [redacted]")
    const jwt = redactSecrets(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    )
    assert.equal(jwt, "[redacted]")
    const header = redactSecrets("Authorization: Bearer abc123def.ghi")
    assert.ok(header.includes("[redacted]"))
    assert.ok(!header.includes("abc123def"))
  })
  it("redacts credentials inside URLs", () => {
    assert.equal(
      redactSecrets("postgres://admin:s3cret@db.local:5432/app"),
      "postgres://[redacted]@db.local:5432/app",
    )
  })
  it("redacts KEY=value pairs with sensitive keys", () => {
    assert.equal(redactSecrets("password=hunter2"), "password=[redacted]")
    assert.ok(redactSecrets('export API_KEY: "abc123"').includes("[redacted]"))
    assert.ok(!redactSecrets('export API_KEY: "abc123"').includes("abc123"))
    assert.equal(redactSecrets("token: abcdef12345"), "token: [redacted]")
  })
  it("redacts private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----"
    assert.equal(redactSecrets(`cert: ${pem}`), "cert: [redacted private key]")
  })
  it("leaves ordinary text and code untouched", () => {
    assert.equal(redactSecrets("edit src/foo.ts"), "edit src/foo.ts")
    assert.equal(redactSecrets("const tokenCount = 5"), "const tokenCount = 5")
    assert.equal(redactSecrets("npm install left-pad"), "npm install left-pad")
  })
})

describe("format: projectName", () => {
  it("returns the directory basename", () => {
    assert.equal(projectName("/some/repo/agentic-workflow"), "agentic-workflow")
  })
  it("returns empty for the home directory itself", () => {
    assert.equal(projectName(homedir()), "")
  })
  it("returns empty for blank input", () => {
    assert.equal(projectName(""), "")
    assert.equal(projectName(undefined), "")
  })
})

describe("format: recentContextLines", () => {
  it("keeps only the last few non-empty lines", () => {
    const out = recentContextLines("a\n\nb\nc\nd")
    assert.equal(out, "b\nc\nd")
  })
  it("returns empty for blank text", () => {
    assert.equal(recentContextLines("   \n  "), "")
  })
  it("redacts each line before truncation applies", () => {
    const out = recentContextLines(`token: ${"x".repeat(200)}`, 3, 20)
    assert.ok(out.includes("[redacted]"))
  })
  it("truncates long plain lines with an ellipsis", () => {
    const out = recentContextLines("y".repeat(100), 3, 20)
    assert.equal(out.length, 20)
    assert.ok(out.endsWith("…"))
  })
})

describe("format: normalizePermission", () => {
  it("maps the runtime permission.asked payload", () => {
    const info = normalizePermission({
      id: "p1",
      sessionID: "s1",
      permission: "bash",
      patterns: ["rm -rf /tmp/x"],
      metadata: { command: "rm -rf /tmp/x" },
      always: ["git *"],
    })
    assert.equal(info.id, "p1")
    assert.equal(info.sessionID, "s1")
    assert.equal(info.kind, "bash")
    assert.deepEqual(info.patterns, ["rm -rf /tmp/x"])
    assert.deepEqual(info.always, ["git *"])
    assert.equal(info.title, "bash: rm -rf /tmp/x")
  })
  it("falls back safely for missing or malformed fields", () => {
    const info = normalizePermission(undefined)
    assert.equal(info.id, "")
    assert.equal(info.kind, "action")
    assert.equal(info.title, "action requires approval")
    const partial = normalizePermission({ permission: 42, patterns: "nope", metadata: "nope" })
    assert.equal(partial.kind, "action")
    assert.deepEqual(partial.patterns, [])
    assert.deepEqual(partial.metadata, {})
  })
})

describe("format: permissionBlocks", () => {
  const permission = normalizePermission({
    id: "p1",
    sessionID: "s1",
    permission: "bash",
    patterns: [],
    metadata: { command: "run /Users/ramesh/tool" },
    always: ["git *"],
  })

  it("renders approval buttons with prefixed action ids and supplied values", () => {
    const blocks = permissionBlocks(permission, "fix bug", "slackbridge", (action) => `v-${action}`)
    const actions = blocks.find((block) => block.type === "actions") as {
      elements: Array<{ action_id?: string; value?: string; style?: string }>
    }
    const ids = actions.elements.map((element) => element.action_id)
    assert.deepEqual(ids, ["slackbridge:once", "slackbridge:always", "slackbridge:reject"])
    assert.deepEqual(
      actions.elements.map((element) => element.value),
      ["v-once", "v-always", "v-reject"],
    )
    assert.equal(actions.elements[0].style, "primary")
    assert.equal(actions.elements[2].style, "danger")
  })

  it("redacts the command and shows the always list in the context block", () => {
    const blocks = permissionBlocks(permission, "fix bug", "x", () => "v")
    const context = blocks.find((block) => block.type === "context") as {
      elements: Array<{ text: string }>
    }
    const text = context.elements[0].text
    assert.ok(text.includes("command: `run /Users/ramesh/tool`"))
    assert.ok(text.includes("always: `git *`"))
    assert.ok(text.includes("fix bug"))
  })

  it("includes the recent context section when provided", () => {
    const blocks = permissionBlocks(permission, "fix bug", "x", () => "v", "did a thing")
    assert.ok(blocks.some((block) => JSON.stringify(block).includes("Recent context")))
  })

  it("never echoes raw file path metadata", () => {
    const withMeta = normalizePermission({
      id: "p1",
      sessionID: "s1",
      permission: "edit",
      patterns: [],
      metadata: { filePath: "/Users/ramesh/secret.txt" },
    })
    const blocks = permissionBlocks(withMeta, "s", "x", () => "v")
    assert.ok(!JSON.stringify(blocks).includes("ramesh"))
  })
})

describe("format: normalizeQuestion", () => {
  it("maps questions with defaults for missing fields", () => {
    const info = normalizeQuestion({
      id: "q1",
      sessionID: "s1",
      questions: [{ question: "Which?", options: [{ label: "A", description: "first" }] }],
    })
    assert.equal(info.questions[0].header, "Question")
    assert.equal(info.questions[0].multiple, false)
    assert.equal(info.questions[0].custom, false)
    assert.deepEqual(info.questions[0].options, [{ label: "A", description: "first" }])
  })
  it("handles missing questions and malformed options", () => {
    const info = normalizeQuestion({ id: "q1" })
    assert.deepEqual(info.questions, [])
    const info2 = normalizeQuestion({ id: "q2", questions: [{ options: "nope", multiple: "yes" }] })
    assert.deepEqual(info2.questions[0].options, [])
    assert.equal(info2.questions[0].multiple, false)
  })
})

describe("format: questionBlocks", () => {
  const info: QuestionRequestInfo = {
    id: "q1",
    sessionID: "s1",
    questions: [
      {
        question: "Pick one",
        header: "Choice",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        multiple: false,
        custom: true,
      },
    ],
  }

  it("emits option buttons carrying opaque JSON payloads with indices", () => {
    const blocks = questionBlocks(info, "s", "slackbridge", [[]])
    const actions = blocks.filter((block) => block.type === "actions") as Array<{
      elements: Array<{ action_id?: string; value?: string; text?: { text?: string }; style?: string }>
    }>
    const optionButtons = actions[0].elements
    assert.deepEqual(
      optionButtons.map((button) => button.action_id),
      ["slackbridge:qopt:0:0", "slackbridge:qopt:0:1"],
    )
    const payload = JSON.parse(optionButtons[0].value ?? "{}") as Record<string, unknown>
    assert.equal(payload.kind, "qopt")
    assert.equal(payload.requestID, "q1")
    assert.equal(payload.index, 0)
    assert.equal(payload.optionIndex, 0)
    assert.equal(optionButtons[0].text?.text, "A")
  })

  it("highlights already-selected options", () => {
    const blocks = questionBlocks(info, "s", "x", [["B"]])
    const actions = blocks.filter((block) => block.type === "actions") as Array<{
      elements: Array<{ style?: string; text?: { text?: string } }>
    }>
    assert.equal(actions[0].elements[1].style, "primary")
    assert.equal(actions[0].elements[0].style, undefined)
  })

  it("emits submit and reject buttons with their payload kinds", () => {
    const blocks = questionBlocks(info, "s", "slackbridge", [[]])
    const actions = blocks.filter((block) => block.type === "actions") as Array<{
      elements: Array<{ action_id?: string; value?: string }>
    }>
    const last = actions[actions.length - 1].elements
    assert.deepEqual(last.map((button) => button.action_id), ["slackbridge:qsubmit", "slackbridge:qreject"])
    const submit = JSON.parse(last[0].value ?? "{}") as { kind?: string }
    assert.equal(submit.kind, "qsubmit")
  })

  it("shows a validation notice when provided", () => {
    const blocks = questionBlocks(info, "s", "x", [[]], "Answer every question before submitting.")
    assert.ok(JSON.stringify(blocks).includes("Answer every question before submitting."))
  })
})

describe("format: text helpers", () => {
  it("permissionText prefixes the redacted title", () => {
    assert.equal(permissionText({ ...normalizePermission({ id: "p", sessionID: "s" }), title: "bash: ls" }), "Approval needed: bash: ls")
  })
  it("questionText uses the first question header", () => {
    const info = normalizeQuestion({ id: "q", questions: [{ header: "Deploy" }] })
    assert.equal(questionText(info), "Input needed: Deploy")
  })
  it("sessionRootText marks the start and the project", () => {
    const text = sessionRootText("fix bug", "/Users/ramesh/code/repo")
    assert.ok(text.startsWith("*Session started* — fix bug"))
    assert.ok(text.includes("_Project: repo_"))
  })
  it("sessionRootText keeps paths in the title readable", () => {
    const text = sessionRootText("work on /Users/ramesh/secret", "/repo")
    assert.ok(text.includes("/Users/ramesh/secret"))
  })
  it("childSessionRootText and pointer mention the child and parent", () => {
    const child = childSessionRootText("sub task", "parent task")
    assert.ok(child.includes("*Subagent session*"))
    assert.ok(child.includes("child of parent task"))
    const pointer = childThreadPointerText("sub task")
    assert.ok(pointer.includes("requesting approval"))
    assert.ok(pointer.includes("sub task"))
  })
  it("resolvedBlocks escape their label", () => {
    const blocks = resolvedBlocks("<script>")
    assert.ok(!JSON.stringify(blocks).includes("<script>"))
  })
  it("sessionStatusText lists pending markers and activity", () => {
    const text = sessionStatusText(
      "fix bug",
      { approval: true, question: false },
      [{ role: "assistant", text: "working on it" }],
    )
    assert.ok(text.includes("*Session status* — fix bug"))
    assert.ok(text.includes("Awaiting approval"))
    assert.ok(text.includes("_assistant_:"))
    assert.ok(text.includes("working on it"))
    const empty = sessionStatusText("fix bug", { approval: false, question: false }, [])
    assert.ok(empty.includes("No recent activity"))
  })
})

describe("format: agentReplyBlocks", () => {
  it("wraps the reply in a single mrkdwn section", () => {
    const blocks = agentReplyBlocks("All tests pass.")
    assert.equal(blocks.length, 1)
    const section = blocks[0] as { type: string; text: { type: string; text: string } }
    assert.equal(section.type, "section")
    assert.equal(section.text.type, "mrkdwn")
    assert.equal(section.text.text, "All tests pass.")
  })
  it("keeps paths readable but redacts secrets from the reply", () => {
    const blocks = agentReplyBlocks(
      "failed to read /Users/ramesh/secret/key.txt — token: abcdef12345",
    )
    const section = blocks[0] as { text: { text: string } }
    assert.ok(section.text.text.includes("/Users/ramesh/secret/key.txt"))
    assert.ok(section.text.text.includes("token: [redacted]"))
  })
  it("escapes mrkdwn control characters", () => {
    const blocks = agentReplyBlocks("a < b & c > d")
    const section = blocks[0] as { text: { text: string } }
    assert.equal(section.text.text, "a &lt; b &amp; c &gt; d")
  })
  it("marks oversized replies as truncated", () => {
    const blocks = agentReplyBlocks("z".repeat(4000))
    const section = blocks[0] as { text: { text: string } }
    assert.ok(section.text.text.length <= 2920)
    assert.ok(section.text.text.endsWith("_(truncated)_"))
  })
  it("handles blank input", () => {
    const blocks = agentReplyBlocks("   ")
    const section = blocks[0] as { text: { text: string } }
    assert.equal(section.text.text, "")
  })
})

describe("format: agentReplyText", () => {
  it("returns a short redacted notification line", () => {
    assert.equal(agentReplyText("done /Users/ramesh/x"), "done /Users/ramesh/x")
  })
  it("truncates long replies", () => {
    const out = agentReplyText("q".repeat(300))
    assert.equal(out.length, 120)
    assert.ok(out.endsWith("…"))
  })
})
