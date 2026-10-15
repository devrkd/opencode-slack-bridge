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
/**
 * True when the command can be safely auto-approved in a Slack-originated
 * (read-only) turn. Multi-segment commands qualify only if every segment
 * does; anything with redirection, command substitution, backgrounding, or
 * an unrecognised program is denied.
 */
export declare function isReadOnlyBashCommand(command: string): boolean;
