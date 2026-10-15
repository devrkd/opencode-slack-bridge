/**
 * Conservative read-only classification for bash commands executed in
 * Slack-originated turns. The bridge uses this to auto-approve clearly
 * read-only commands and auto-deny everything else — a prompt typed in a
 * Slack thread must never be able to mutate the workspace, invoke arbitrary
 * programs, or reach the network.
 *
 * The default is deny: any command that is not explicitly recognised as
 * read-only is rejected. Shell metacharacters that could redirect output
 * into a file, substitute commands, or spawn background jobs fail the whole
 * command, and multi-segment commands (pipes, `;`, `&&`, `||`) are accepted
 * only when every segment qualifies.
 */

/** Commands whose every form is read-only. */
const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "pwd",
  "wc",
  "which",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "diff",
  "sort",
  "uniq",
  "comm",
  "cmp",
  "date",
  "uname",
  "whoami",
  "id",
  "tty",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "jq",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "cksum",
  "echo",
  "true",
  "false",
  "test",
])

/** `git` subcommands that only read repository state. */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
  "ls-remote",
  "grep",
])

/** `find` flags that mutate the filesystem or execute programs. */
const FIND_WRITE_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
])

/** Segment text that could redirect, substitute, or background — always deny. */
const UNSAFE_SEGMENT = /[<>]|\$\(|\$\{|`|&\s*$/

function isReadOnlySegment(segment: string): boolean {
  let tokens = segment.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  // Strip leading environment assignments (`FOO=bar cmd ...`).
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens = tokens.slice(1)
  }
  const [cmd, ...args] = tokens
  if (cmd === "git") {
    if (args.length === 0) return true
    const sub = args[0]
    // Only the explicit read-only forms: `git worktree list`, `git stash list`.
    if (sub === "worktree" || sub === "stash") return args[1] === "list"
    return GIT_READ_ONLY_SUBCOMMANDS.has(sub)
  }
  if (cmd === "find") {
    return !args.some((arg) => FIND_WRITE_FLAGS.has(arg))
  }
  return READ_ONLY_COMMANDS.has(cmd)
}

/**
 * True when the command can be safely auto-approved in a Slack-originated
 * (read-only) turn. Multi-segment commands qualify only if every segment
 * does; anything with redirection, command substitution, backgrounding, or
 * an unrecognised program is denied.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const clean = (command ?? "").trim()
  if (!clean) return false
  const segments = clean.split(/\|\||&&|;|\|/)
  if (segments.length === 0) return false
  return segments.every((segment) => {
    const s = segment.trim()
    if (!s) return false
    if (UNSAFE_SEGMENT.test(s)) return false
    return isReadOnlySegment(s)
  })
}
