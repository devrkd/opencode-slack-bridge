import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import {
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
  redactHostInfo,
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

describe("format: redactHostInfo (security)", () => {
  it("redacts absolute unix paths", () => {
    assert.equal(redactHostInfo("cannot read /Users/ramesh/secret/key.txt"), "cannot read [path]")
    assert.equal(redactHostInfo("see /home/dev/build.log for detail"), "see [path] for detail")
    assert.equal(redactHostInfo("cached in /var/folders/ps/x/y/T"), "cached in [path]")
  })
  it("redacts windows drive and UNC paths", () => {
    assert.equal(redactHostInfo("open C:\\Users\\dev\\file.txt now"), "open [path] now")
    assert.equal(redactHostInfo("share \\\\FILESERVER\\projects\\x"), "share [path]")
  })
  it("never lets hostnames or usernames leak through the placeholder", () => {
    const out = redactHostInfo("error at /Users/ramesh/secret: permission denied")
    assert.ok(!out.includes("ramesh"))
    assert.ok(out.includes("[path]"))
  })
  it("leaves relative paths and plain text alone", () => {
    assert.equal(redactHostInfo("edit src/foo.ts"), "edit src/foo.ts")
    assert.equal(redactHostInfo("no paths here"), "no paths here")
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
    const out = recentContextLines(`/Users/ramesh/secret/${"x".repeat(200)}`, 3, 20)
    assert.ok(out.includes("[path]"))
    assert.ok(!out.includes("ramesh"))
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
    assert.ok(text.includes("command: `run [path]`"))
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
  it("sessionRootText redacts host detail from the title", () => {
    const text = sessionRootText("work on /Users/ramesh/secret", "/repo")
    assert.ok(!text.includes("ramesh"))
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
