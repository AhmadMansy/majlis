import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Role = 'host' | 'member'

export interface Member {
  id: string
  name: string
  role: Role
  lastSeen: string | null
}

export interface RoomEvent {
  seq: number
  ts: string
  authorId: string
  authorName: string
  body: string
  replyTo: number | null
}

interface Waiter {
  memberId: string
  wake: () => void
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * The room's conversation log. The host process is the only writer of
 * messages, so `seq` is a single total order every copy can follow.
 */
export class RoomStore {
  readonly #db: DatabaseSync
  readonly #waiters = new Set<Waiter>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        cursor INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        author_id TEXT NOT NULL REFERENCES members(id),
        body TEXT NOT NULL,
        reply_to INTEGER
      );
    `)
  }

  close(): void {
    this.#db.close()
  }

  /** Creates a member and returns the one-time plaintext token; only its hash is stored. */
  addMember(name: string, role: Role): { member: Member; token: string } {
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    this.#db
      .prepare(
        'INSERT INTO members (id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, name, role, hashToken(token), new Date().toISOString())
    return { member: { id, name, role, lastSeen: null }, token }
  }

  /** Replaces a member's token, invalidating the old one. Returns undefined for an unknown name. */
  rotateToken(name: string): string | undefined {
    const token = randomBytes(32).toString('base64url')
    const result = this.#db
      .prepare('UPDATE members SET token_hash = ? WHERE name = ? AND revoked = 0')
      .run(hashToken(token), name)
    return Number(result.changes) > 0 ? token : undefined
  }

  memberByName(name: string): Member | undefined {
    return this.#toMember(
      this.#db.prepare('SELECT id, name, role, last_seen FROM members WHERE name = ?').get(name),
    )
  }

  memberByToken(token: string): Member | undefined {
    return this.#toMember(
      this.#db
        .prepare(
          'SELECT id, name, role, last_seen FROM members WHERE token_hash = ? AND revoked = 0',
        )
        .get(hashToken(token)),
    )
  }

  memberById(id: string): Member | undefined {
    return this.#toMember(
      this.#db
        .prepare('SELECT id, name, role, last_seen FROM members WHERE id = ? AND revoked = 0')
        .get(id),
    )
  }

  members(): Member[] {
    return this.#db
      .prepare(
        'SELECT id, name, role, last_seen FROM members WHERE revoked = 0 ORDER BY created_at',
      )
      .all()
      .map((row) => this.#toMember(row))
      .filter((m): m is Member => m !== undefined)
  }

  touch(memberId: string): void {
    this.#db
      .prepare('UPDATE members SET last_seen = ? WHERE id = ?')
      .run(new Date().toISOString(), memberId)
  }

  append(authorId: string, body: string, replyTo: number | null): RoomEvent {
    const ts = new Date().toISOString()
    const result = this.#db
      .prepare('INSERT INTO events (ts, author_id, body, reply_to) VALUES (?, ?, ?, ?)')
      .run(ts, authorId, body, replyTo)
    const seq = Number(result.lastInsertRowid)
    // The author's read cursor is left alone: posting must not hide peers' unread messages.
    for (const waiter of [...this.#waiters]) {
      if (waiter.memberId !== authorId) waiter.wake()
    }
    const author = this.memberById(authorId)
    return { seq, ts, authorId, authorName: author?.name ?? 'unknown', body, replyTo }
  }

  eventCount(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM events').get()
    return Number(row?.n ?? 0)
  }

  hasEvent(seq: number): boolean {
    return this.#db.prepare('SELECT 1 AS x FROM events WHERE seq = ?').get(seq) !== undefined
  }

  /** Messages from other members that this member has not read yet. */
  unread(memberId: string): RoomEvent[] {
    return this.#db
      .prepare(
        `SELECT e.seq, e.ts, e.author_id, m.name AS author_name, e.body, e.reply_to
         FROM events e JOIN members m ON m.id = e.author_id
         WHERE e.author_id != ? AND e.seq > (SELECT cursor FROM members WHERE id = ?)
         ORDER BY e.seq`,
      )
      .all(memberId, memberId)
      .map(toEvent)
  }

  markRead(memberId: string, seq: number): void {
    this.#db.prepare('UPDATE members SET cursor = MAX(cursor, ?) WHERE id = ?').run(seq, memberId)
  }

  /** The most recent messages, oldest first, optionally only those before `beforeSeq`. */
  history(limit: number, beforeSeq?: number): RoomEvent[] {
    return this.#db
      .prepare(
        `SELECT e.seq, e.ts, e.author_id, m.name AS author_name, e.body, e.reply_to
         FROM events e JOIN members m ON m.id = e.author_id
         WHERE e.seq < ?
         ORDER BY e.seq DESC LIMIT ?`,
      )
      .all(beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
      .map(toEvent)
      .reverse()
  }

  /**
   * Resolves `true` as soon as another member posts, or `false` on timeout or abort.
   * Callers check `unread()` first; this only covers the gap until the next post.
   */
  waitForOthers(memberId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(false)
        return
      }
      const finish = (woken: boolean) => {
        clearTimeout(timer)
        this.#waiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
        resolve(woken)
      }
      const waiter: Waiter = { memberId, wake: () => finish(true) }
      const onAbort = () => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#waiters.add(waiter)
    })
  }

  #toMember(row: Record<string, unknown> | undefined): Member | undefined {
    if (!row) return undefined
    return {
      id: String(row.id),
      name: String(row.name),
      role: row.role === 'host' ? 'host' : 'member',
      lastSeen: row.last_seen == null ? null : String(row.last_seen),
    }
  }
}

function toEvent(row: Record<string, unknown>): RoomEvent {
  return {
    seq: Number(row.seq),
    ts: String(row.ts),
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    body: String(row.body),
    replyTo: row.reply_to == null ? null : Number(row.reply_to),
  }
}
