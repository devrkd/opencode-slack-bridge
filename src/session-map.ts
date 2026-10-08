import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type SessionRef = {
  channel: string
  ts: string
  title: string
  createdAt: number
  /** Set for child (subagent) session threads; the Slack thread's parent session. */
  parentID?: string
}

/**
 * Persists the opencode session id -> Slack thread mapping so a plugin
 * reload (or restart) keeps posting into the same thread instead of
 * spawning a duplicate root message.
 */
export class SessionMap {
  private refs = new Map<string, SessionRef>()
  private file: string

  constructor(file: string) {
    this.file = file
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, SessionRef>
      for (const [id, ref] of Object.entries(parsed)) {
        if (ref && typeof ref.ts === "string" && typeof ref.channel === "string") {
          this.refs.set(id, ref)
        }
      }
    } catch {
      // A corrupt state file should not stop the bridge; start clean.
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.refs), null, 2))
      renameSync(tmp, this.file)
    } catch {
      // Persistence is best-effort.
    }
  }

  get(id: string): SessionRef | undefined {
    return this.refs.get(id)
  }

  has(id: string): boolean {
    return this.refs.has(id)
  }

  set(id: string, ref: SessionRef): void {
    this.refs.set(id, ref)
    this.save()
  }

  delete(id: string): void {
    this.refs.delete(id)
    this.save()
  }

  entries(): IterableIterator<[string, SessionRef]> {
    return this.refs.entries()
  }

  sessionForThread(ts: string): string | undefined {
    for (const [id, ref] of this.refs) {
      if (ref.ts === ts) return id
    }
    return undefined
  }
}
