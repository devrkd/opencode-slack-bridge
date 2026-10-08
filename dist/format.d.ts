import type { KnownBlock } from "@slack/types";
export type SlackBlock = KnownBlock;
/** Normalized view of an opencode `permission.asked` event. */
export type PermissionInfo = {
    id: string;
    sessionID: string;
    kind: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
    title: string;
};
/**
 * The runtime `permission.asked` payload is not the SDK `Permission` shape:
 *   { id, sessionID, permission, patterns, metadata, always, tool }
 */
export declare function normalizePermission(raw: unknown): PermissionInfo;
/** Escape the three characters Slack interprets inside mrkdwn text. */
export declare function escapeMrkdwn(text: string): string;
export declare function truncate(text: string, max?: number): string;
/**
 * Strips host-specific detail from arbitrary text before it is posted to
 * Slack. Absolute macOS/Linux paths, Windows drive paths, and UNC share
 * paths are replaced with a `[path]` placeholder so no hostnames,
 * usernames, or local directory structure leak into the channel.
 */
export declare function redactHostInfo(text: string): string;
/**
 * Project name for a working directory, without any host detail. Returns
 * the directory's basename — the repo/project the agent is working on —
 * unless the session runs at the user's home directory itself, in which
 * case there is no project name to show.
 */
export declare function projectName(directory?: string): string;
export declare function sessionRootText(title: string, directory?: string): string;
/** Root message for a child (subagent) session thread, created lazily. */
export declare function childSessionRootText(title: string, parentTitle?: string): string;
/** One-line notice dropped into the parent thread when a child thread is created. */
export declare function childThreadPointerText(childTitle: string): string;
/**
 * Compact, redacted context summary: the last few non-empty lines of text
 * (e.g. the tail of the last assistant message), suitable for the context
 * block of an approval or question card.
 */
export declare function recentContextLines(text: string, maxLines?: number, maxChars?: number): string;
/** One recent message worth of role-labelled text for a `/s` reply. */
export type StatusActivity = {
    role: string;
    text: string;
};
/**
 * Text for the ephemeral `/s` reply: the session title, any pending
 * approval/question markers, and the last few activity lines. Everything is
 * redacted and truncated exactly like the cards, so no host detail leaks.
 */
export declare function sessionStatusText(title: string, pending: {
    approval: boolean;
    question: boolean;
}, activity: StatusActivity[]): string;
export declare function permissionText(permission: PermissionInfo): string;
export type PermissionAction = "once" | "always" | "reject";
export declare function permissionBlocks(permission: PermissionInfo, sessionTitle: string, actionPrefix: string, valueFor: (action: PermissionAction) => string, context?: string): SlackBlock[];
export declare function resolvedBlocks(label: string): SlackBlock[];
/** Normalized view of an opencode `question.asked` event. */
export type QuestionOption = {
    label: string;
    description: string;
};
export type QuestionItem = {
    question: string;
    header: string;
    options: QuestionOption[];
    multiple: boolean;
    custom: boolean;
};
export type QuestionRequestInfo = {
    id: string;
    sessionID: string;
    questions: QuestionItem[];
};
export declare function normalizeQuestion(raw: unknown): QuestionRequestInfo;
export declare function questionText(info: QuestionRequestInfo): string;
export declare function questionBlocks(info: QuestionRequestInfo, sessionTitle: string, actionPrefix: string, selected: string[][], notice?: string, context?: string): SlackBlock[];
