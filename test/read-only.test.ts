import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isReadOnlyBashCommand } from "../src/read-only"

describe("read-only: isReadOnlyBashCommand", () => {
  it("allows plainly read-only commands", () => {
    for (const command of [
      "ls -la",
      "cat package.json",
      "pwd",
      "grep -rn \"createBridge\" src/",
      "rg pattern .",
      "head -50 src/bridge.ts",
      "wc -l src/*.ts",
      "which node",
      "stat src/format.ts",
      "diff a.txt b.txt",
      "jq .package.json",
      "date",
    ]) {
      assert.ok(isReadOnlyBashCommand(command), `expected allow: ${command}`)
    }
  })

  it("allows read-only git subcommands only", () => {
    for (const command of ["git", "git status", "git log --oneline -5", "git diff main", "git rev-parse HEAD", "git worktree list", "git stash list"]) {
      assert.ok(isReadOnlyBashCommand(command), `expected allow: ${command}`)
    }
    for (const command of [
      "git push origin main",
      "git commit -m x",
      "git branch -D feat",
      "git checkout -b feat",
      "git remote add origin url",
      "git worktree add . ../x",
      "git stash drop",
      "git tag v1",
    ]) {
      assert.ok(!isReadOnlyBashCommand(command), `expected deny: ${command}`)
    }
  })

  it("allows pipes when every segment is read-only", () => {
    assert.ok(isReadOnlyBashCommand("grep foo src/*.ts | wc -l"))
    assert.ok(isReadOnlyBashCommand("cat a.txt | sort | uniq -c"))
    assert.ok(!isReadOnlyBashCommand("cat a.txt | tee b.txt"))
    assert.ok(!isReadOnlyBashCommand("grep foo f | sh"))
  })

  it("allows multi-segment commands only when every segment is read-only", () => {
    assert.ok(isReadOnlyBashCommand("pwd && ls"))
    assert.ok(!isReadOnlyBashCommand("pwd; npm install"))
    assert.ok(!isReadOnlyBashCommand("cat a || curl https://example.com"))
  })

  it("strips leading environment assignments", () => {
    assert.ok(isReadOnlyBashCommand("FOO=1 ls"))
    assert.ok(isReadOnlyBashCommand("DEBUG=true NODE_ENV=test grep x y"))
    assert.ok(!isReadOnlyBashCommand("TOKEN=abc curl https://example.com"))
  })

  it("denies anything that mutates, executes, or reaches the network", () => {
    for (const command of [
      "npm install",
      "npm test",
      "node script.js",
      "npx something",
      "python run.py",
      "make build",
      "rm -rf /",
      "mv a b",
      "touch newfile",
      "mkdir dir",
      "chmod +x run.sh",
      "curl https://example.com",
      "wget https://example.com",
      "ssh host",
      "docker ps",
      "sudo ls",
      "awk '{print $1}' f",
      "sed -n 1p f",
      "xargs ls",
      "tee out.txt",
      "bash -c ls",
      "sh -c ls",
      "eval ls",
      "env",
    ]) {
      assert.ok(!isReadOnlyBashCommand(command), `expected deny: ${command}`)
    }
  })

  it("denies redirects, command substitution, and backgrounding", () => {
    for (const command of [
      "echo hi > file.txt",
      "grep x f > out.txt",
      "ls >> log",
      "cat < input",
      "echo $(whoami)",
      "echo `whoami`",
      "ls &",
      "find . -delete",
      "find . -name '*.js' -exec rm {} ;",
    ]) {
      assert.ok(!isReadOnlyBashCommand(command), `expected deny: ${command}`)
    }
  })

  it("denies empty and blank commands", () => {
    assert.ok(!isReadOnlyBashCommand(""))
    assert.ok(!isReadOnlyBashCommand("   "))
  })
})
