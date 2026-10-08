export type SessionRef = {
    channel: string;
    ts: string;
    title: string;
    createdAt: number;
    /** Set for child (subagent) session threads; the Slack thread's parent session. */
    parentID?: string;
};
/**
 * Persists the opencode session id -> Slack thread mapping so a plugin
 * reload (or restart) keeps posting into the same thread instead of
 * spawning a duplicate root message.
 */
export declare class SessionMap {
    private refs;
    private file;
    constructor(file: string);
    private load;
    private save;
    get(id: string): SessionRef | undefined;
    has(id: string): boolean;
    set(id: string, ref: SessionRef): void;
    delete(id: string): void;
    entries(): IterableIterator<[string, SessionRef]>;
    sessionForThread(ts: string): string | undefined;
}
