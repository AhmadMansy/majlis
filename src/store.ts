import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Role = 'host' | 'member' | 'observer'

export type EventKind =
  | 'message'
  | 'debate_opened'
  | 'position'
  | 'proposal'
  | 'response'
  | 'escalation'
  | 'decision'
  | 'report'
  | 'profile'
  | 'contract'

export interface Member {
  id: string
  name: string
  role: Role
  lastSeen: string | null
  /** What this member's agent says it owns and knows, so peers know what to ask it. */
  profile: string
}

/** A shared definition both sides build against, such as an interface or payload format. */
export interface Contract {
  name: string
  content: string
  note: string
  version: number
  updatedBy: string
  updatedAt: string
}

export interface RoomEvent {
  seq: number
  ts: string
  authorId: string
  authorName: string
  kind: EventKind
  body: string
  replyTo: number | null
  debateId: number | null
  data: Record<string, unknown>
}

export interface NewEvent {
  authorId: string
  kind: EventKind
  body: string
  replyTo?: number | null
  debateId?: number | null
  data?: Record<string, unknown>
}

export interface Action {
  owner: string
  action: string
}

export interface Decision {
  resolution: string
  rationale: string
  actions: Action[]
  decidedBy: 'agreement' | 'humans'
  acceptedBy: string[]
  recordedBy: string
  ts: string
}

export type DebateStatus = 'open' | 'escalated' | 'decided'

export interface Debate {
  id: number
  question: string
  options: string[]
  context: string
  openedBy: string
  openedAt: string
  status: DebateStatus
  maxRounds: number
  decision: Decision | null
}

export interface ReportNote {
  member: string
  kind: 'signoff' | 'dissent'
  note: string
  ts: string
}

export interface StoredReport {
  id: number
  key: string
  debateId: number | null
  author: string
  content: Record<string, unknown>
  notes: ReportNote[]
  fromSeq: number
  toSeq: number
  updatedAt: string
}

export interface Settings {
  /** When true, nobody can post; reading still works. */
  paused: boolean
  debates: boolean
  reports: boolean
  maxMessageChars: number
  /** Posts of any kind allowed per member in a rolling hour. */
  postsPerHour: number
  /** Positions each member may post in one debate before they must resolve or escalate. */
  maxRounds: number
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  debates: true,
  reports: true,
  maxMessageChars: 8000,
  postsPerHour: 60,
  maxRounds: 4,
}

/** When this machine's own agent must wait for its human before a post leaves the machine. */
export type ApprovalMode = 'every' | 'debate' | 'auto'

/** Settings that belong to this machine and are never synced to anyone else. */
export interface LocalSettings {
  approval: ApprovalMode
  /** Text that must never leave this machine: plain substrings, or patterns with `*`. */
  deny: string[]
  /** Debates the human has already approved posting in, for the `debate` mode. */
  approvedDebates: number[]
}

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  approval: 'every',
  deny: [],
  approvedDebates: [],
}

/** How a member's copy reaches the room it mirrors. Holds the member's secret token. */
export interface MirrorConfig {
  hostUrl: string
  token: string
  meId: string
  /** The room's name as the host calls it. */
  room: string
}

export type OutboxStatus = 'awaiting_approval' | 'queued' | 'sent' | 'failed' | 'rejected'

/** One post by this machine's agent or human, on its way to the room. */
export interface OutboxItem {
  id: string
  action: string
  input: Record<string, unknown>
  status: OutboxStatus
  /** What the room answered, or why it failed. */
  result: string
  human: boolean
  debateId: number | null
  createdAt: string
  updatedAt: string
}

/** A member as sent to copies: includes removed members, whose names old messages still need. */
export interface MemberRecord {
  id: string
  name: string
  role: Role
  active: boolean
  createdAt: string
  profile: string
}

interface Waiter {
  memberId: string
  wake: () => void
}

type Row = Record<string, unknown>

const SCHEMA_VERSION = 2

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')
const now = (): string => new Date().toISOString()

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const EVENT_COLUMNS = `e.seq, e.ts, e.author_id, m.name AS author_name, e.kind, e.body, e.reply_to, e.debate_id, e.data`

/**
 * The room's log and state. The host process is the only writer, so `seq`
 * is a single total order every copy can follow.
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
      CREATE TABLE IF NOT EXISTS debates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        context TEXT NOT NULL,
        opened_by TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        status TEXT NOT NULL,
        max_rounds INTEGER NOT NULL,
        decision TEXT
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        debate_id INTEGER UNIQUE,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '[]',
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        human INTEGER NOT NULL DEFAULT 0,
        debate_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contracts (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        content TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS acts (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        ok INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    this.#migrate()
  }

  /** Rooms created by the first spike have an events table without the newer columns. */
  #migrate(): void {
    const columns = new Set(
      this.#db
        .prepare('PRAGMA table_info(events)')
        .all()
        .map((column) => String(column.name)),
    )
    if (!columns.has('kind')) {
      this.#db.exec(`ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'`)
    }
    if (!columns.has('debate_id')) this.#db.exec('ALTER TABLE events ADD COLUMN debate_id INTEGER')
    if (!columns.has('data')) this.#db.exec('ALTER TABLE events ADD COLUMN data TEXT')
    const memberColumns = new Set(
      this.#db
        .prepare('PRAGMA table_info(members)')
        .all()
        .map((column) => String(column.name)),
    )
    if (!memberColumns.has('profile')) {
      this.#db.exec(`ALTER TABLE members ADD COLUMN profile TEXT NOT NULL DEFAULT ''`)
    }
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  close(): void {
    this.#db.close()
  }

  // ── Members ────────────────────────────────────────────────────────────

  /** Creates a member and returns the one-time plaintext token; only its hash is stored. */
  addMember(name: string, role: Role): { member: Member; token: string } {
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    this.#db
      .prepare(
        'INSERT INTO members (id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, name, role, hashToken(token), now())
    return { member: { id, name, role, lastSeen: null, profile: '' }, token }
  }

  /** Replaces a member's token, invalidating the old one. Returns undefined for an unknown name. */
  rotateToken(name: string): string | undefined {
    const token = randomBytes(32).toString('base64url')
    const result = this.#db
      .prepare('UPDATE members SET token_hash = ? WHERE name = ? AND revoked = 0')
      .run(hashToken(token), name)
    return Number(result.changes) > 0 ? token : undefined
  }

  /** Removes a member's access. Their past messages stay in the log. */
  revoke(memberId: string): boolean {
    const result = this.#db
      .prepare(`UPDATE members SET revoked = 1 WHERE id = ? AND role != 'host'`)
      .run(memberId)
    return Number(result.changes) > 0
  }

  setRole(memberId: string, role: 'member' | 'observer'): boolean {
    const result = this.#db
      .prepare(`UPDATE members SET role = ? WHERE id = ? AND role != 'host' AND revoked = 0`)
      .run(role, memberId)
    return Number(result.changes) > 0
  }

  memberByName(name: string): Member | undefined {
    return toMember(
      this.#db
        .prepare(
          'SELECT id, name, role, last_seen, profile FROM members WHERE name = ? AND revoked = 0',
        )
        .get(name),
    )
  }

  /** True when the name was ever used, including by a removed member; names are never reused. */
  nameTaken(name: string): boolean {
    return this.#db.prepare('SELECT 1 AS x FROM members WHERE name = ?').get(name) !== undefined
  }

  memberByToken(token: string): Member | undefined {
    return toMember(
      this.#db
        .prepare(
          'SELECT id, name, role, last_seen, profile FROM members WHERE token_hash = ? AND revoked = 0',
        )
        .get(hashToken(token)),
    )
  }

  memberById(id: string): Member | undefined {
    return toMember(
      this.#db
        .prepare(
          'SELECT id, name, role, last_seen, profile FROM members WHERE id = ? AND revoked = 0',
        )
        .get(id),
    )
  }

  /** A member's display name, including members who have since been removed. */
  memberName(id: string): string {
    const row = this.#db.prepare('SELECT name FROM members WHERE id = ?').get(id)
    return row ? String(row.name) : 'unknown'
  }

  hostMember(): Member | undefined {
    return toMember(
      this.#db
        .prepare(
          `SELECT id, name, role, last_seen, profile FROM members WHERE role = 'host' AND revoked = 0 ORDER BY created_at LIMIT 1`,
        )
        .get(),
    )
  }

  members(): Member[] {
    return this.#db
      .prepare(
        'SELECT id, name, role, last_seen, profile FROM members WHERE revoked = 0 ORDER BY created_at',
      )
      .all()
      .map((row) => toMember(row))
      .filter((m): m is Member => m !== undefined)
  }

  touch(memberId: string): void {
    this.#db.prepare('UPDATE members SET last_seen = ? WHERE id = ?').run(now(), memberId)
  }

  // ── Settings ───────────────────────────────────────────────────────────

  settings(): Settings {
    const row = this.#db.prepare(`SELECT value FROM settings WHERE key = 'room'`).get()
    return { ...DEFAULT_SETTINGS, ...parseJson<Partial<Settings>>(row?.value, {}) }
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch }
    this.#db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('room', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(next))
    return next
  }

  // ── Events ─────────────────────────────────────────────────────────────

  append(event: NewEvent): RoomEvent {
    const ts = now()
    const result = this.#db
      .prepare(
        'INSERT INTO events (ts, author_id, kind, body, reply_to, debate_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        ts,
        event.authorId,
        event.kind,
        event.body,
        event.replyTo ?? null,
        event.debateId ?? null,
        JSON.stringify(event.data ?? {}),
      )
    const seq = Number(result.lastInsertRowid)
    // The author's read cursor is left alone: posting must not hide peers' unread messages.
    for (const waiter of [...this.#waiters]) {
      if (waiter.memberId !== event.authorId) waiter.wake()
    }
    return this.event(seq) as RoomEvent
  }

  event(seq: number): RoomEvent | undefined {
    const row = this.#db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e JOIN members m ON m.id = e.author_id WHERE e.seq = ?`,
      )
      .get(seq)
    return row ? toEvent(row) : undefined
  }

  eventCount(): number {
    return Number(this.#db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0)
  }

  lastSeq(): number {
    return Number(this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events').get()?.n ?? 0)
  }

  /** Total events posted, by member id. */
  postCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const row of this.#db
      .prepare('SELECT author_id, COUNT(*) AS n FROM events GROUP BY author_id')
      .all()) {
      counts[String(row.author_id)] = Number(row.n)
    }
    return counts
  }

  /** How many events the member has posted since the given moment. */
  postsSince(memberId: string, sinceIso: string): number {
    return Number(
      this.#db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE author_id = ? AND ts >= ?')
        .get(memberId, sinceIso)?.n ?? 0,
    )
  }

  /** Events from other members that this member has not read yet. */
  unread(memberId: string): RoomEvent[] {
    return this.#db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e JOIN members m ON m.id = e.author_id
         WHERE e.author_id != ? AND e.seq > (SELECT cursor FROM members WHERE id = ?)
         ORDER BY e.seq`,
      )
      .all(memberId, memberId)
      .map(toEvent)
  }

  markRead(memberId: string, seq: number): void {
    this.#db.prepare('UPDATE members SET cursor = MAX(cursor, ?) WHERE id = ?').run(seq, memberId)
  }

  /** The most recent events, oldest first, optionally only those before `beforeSeq`. */
  history(limit: number, beforeSeq?: number): RoomEvent[] {
    return this.#db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e JOIN members m ON m.id = e.author_id
         WHERE e.seq < ? ORDER BY e.seq DESC LIMIT ?`,
      )
      .all(beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
      .map(toEvent)
      .reverse()
  }

  /** Events in `(afterSeq, toSeq]`, oldest first. */
  eventsBetween(afterSeq: number, toSeq = Number.MAX_SAFE_INTEGER, limit = 1000): RoomEvent[] {
    return this.#db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e JOIN members m ON m.id = e.author_id
         WHERE e.seq > ? AND e.seq <= ? ORDER BY e.seq LIMIT ?`,
      )
      .all(afterSeq, toSeq, limit)
      .map(toEvent)
  }

  debateEvents(debateId: number): RoomEvent[] {
    return this.#db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e JOIN members m ON m.id = e.author_id
         WHERE e.debate_id = ? ORDER BY e.seq`,
      )
      .all(debateId)
      .map(toEvent)
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

  /** Resolves `true` as soon as anyone posts, or `false` on timeout or abort. */
  waitForEvent(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    // No member has an empty id, so this waiter is woken by every author.
    return this.waitForOthers('', timeoutMs, signal)
  }

  // ── Debates ────────────────────────────────────────────────────────────

  createDebate(input: {
    question: string
    options: string[]
    context: string
    openedBy: string
    maxRounds: number
  }): Debate {
    const result = this.#db
      .prepare(
        `INSERT INTO debates (question, options, context, opened_by, opened_at, status, max_rounds)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        input.question,
        JSON.stringify(input.options),
        input.context,
        input.openedBy,
        now(),
        input.maxRounds,
      )
    return this.debate(Number(result.lastInsertRowid)) as Debate
  }

  debate(id: number): Debate | undefined {
    const row = this.#db.prepare('SELECT * FROM debates WHERE id = ?').get(id)
    return row ? toDebate(row) : undefined
  }

  debates(): Debate[] {
    return this.#db.prepare('SELECT * FROM debates ORDER BY id').all().map(toDebate)
  }

  setDebateStatus(id: number, status: DebateStatus, decision?: Decision): void {
    this.#db
      .prepare('UPDATE debates SET status = ?, decision = COALESCE(?, decision) WHERE id = ?')
      .run(status, decision ? JSON.stringify(decision) : null, id)
  }

  // ── Reports ────────────────────────────────────────────────────────────

  /** Saves a report. A debate has at most one report; submitting again replaces its content. */
  saveReport(input: {
    debateId: number | null
    author: string
    content: Record<string, unknown>
    fromSeq: number
    toSeq: number
  }): StoredReport {
    const existing = input.debateId === null ? undefined : this.reportForDebate(input.debateId)
    if (existing) {
      this.#db
        .prepare(
          'UPDATE reports SET author = ?, content = ?, to_seq = ?, updated_at = ? WHERE id = ?',
        )
        .run(input.author, JSON.stringify(input.content), input.toSeq, now(), existing.id)
      return this.report(existing.id) as StoredReport
    }
    const result = this.#db
      .prepare(
        `INSERT INTO reports (key, debate_id, author, content, from_seq, to_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomBytes(18).toString('base64url'),
        input.debateId,
        input.author,
        JSON.stringify(input.content),
        input.fromSeq,
        input.toSeq,
        now(),
      )
    return this.report(Number(result.lastInsertRowid)) as StoredReport
  }

  report(id: number): StoredReport | undefined {
    return toReport(this.#db.prepare('SELECT * FROM reports WHERE id = ?').get(id))
  }

  reportByKey(key: string): StoredReport | undefined {
    return toReport(this.#db.prepare('SELECT * FROM reports WHERE key = ?').get(key))
  }

  reportForDebate(debateId: number): StoredReport | undefined {
    return toReport(this.#db.prepare('SELECT * FROM reports WHERE debate_id = ?').get(debateId))
  }

  reports(): StoredReport[] {
    return this.#db
      .prepare('SELECT * FROM reports ORDER BY id')
      .all()
      .map((row) => toReport(row))
      .filter((r): r is StoredReport => r !== undefined)
  }

  /** The last event covered by the newest whole-room report, or 0 when there is none. */
  lastRoomReportSeq(): number {
    return Number(
      this.#db
        .prepare('SELECT COALESCE(MAX(to_seq), 0) AS n FROM reports WHERE debate_id IS NULL')
        .get()?.n ?? 0,
    )
  }

  setReportNotes(id: number, notes: ReportNote[]): void {
    this.#db
      .prepare('UPDATE reports SET notes = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(notes), now(), id)
  }

  /** Reports created or changed after the given moment; all of them for an empty string. */
  reportsSince(iso: string): StoredReport[] {
    return this.#db
      .prepare('SELECT * FROM reports WHERE updated_at > ? ORDER BY id')
      .all(iso)
      .map((row) => toReport(row))
      .filter((r): r is StoredReport => r !== undefined)
  }

  // ── This machine: kind, local settings, outbox ─────────────────────────

  #value<T>(key: string, fallback: T): T {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return parseJson<T>(row?.value, fallback)
  }

  #setValue(key: string, value: unknown): void {
    this.#db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value))
  }

  /** Whether this database is the room itself or a member's copy. Rooms older than copies are hosts. */
  kind(): 'host' | 'mirror' | 'new' {
    const kind = this.#value<string>('kind', '')
    if (kind === 'host' || kind === 'mirror') return kind
    return this.hostMember() ? 'host' : 'new'
  }

  setKind(kind: 'host' | 'mirror'): void {
    this.#setValue('kind', kind)
  }

  localSettings(): LocalSettings {
    return { ...DEFAULT_LOCAL_SETTINGS, ...this.#value<Partial<LocalSettings>>('local', {}) }
  }

  updateLocalSettings(patch: Partial<LocalSettings>): LocalSettings {
    const next = { ...this.localSettings(), ...patch }
    this.#setValue('local', next)
    return next
  }

  /** The newest event a hook has already told the owner's agent about. */
  hookSeq(): number {
    return this.#value<number>('hookSeq', 0)
  }

  setHookSeq(seq: number): void {
    this.#setValue('hookSeq', seq)
  }

  mirrorConfig(): MirrorConfig | undefined {
    return this.#value<MirrorConfig | undefined>('mirror', undefined)
  }

  setMirrorConfig(config: MirrorConfig): void {
    this.#setValue('mirror', config)
  }

  addOutbox(input: {
    action: string
    input: Record<string, unknown>
    status: OutboxStatus
    human: boolean
    debateId: number | null
  }): OutboxItem {
    const id = randomUUID()
    const ts = now()
    this.#db
      .prepare(
        `INSERT INTO outbox (id, action, input, status, human, debate_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.action,
        JSON.stringify(input.input),
        input.status,
        input.human ? 1 : 0,
        input.debateId,
        ts,
        ts,
      )
    return this.outboxItem(id) as OutboxItem
  }

  outboxItem(id: string): OutboxItem | undefined {
    const row = this.#db.prepare('SELECT * FROM outbox WHERE id = ?').get(id)
    return row ? toOutbox(row) : undefined
  }

  setOutbox(id: string, status: OutboxStatus, result: string): OutboxItem | undefined {
    this.#db
      .prepare('UPDATE outbox SET status = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(status, result, now(), id)
    return this.outboxItem(id)
  }

  /** Unfinished items oldest first, then the most recently finished ones. */
  outbox(recent = 20): OutboxItem[] {
    const open = this.#db
      .prepare(
        `SELECT * FROM outbox WHERE status IN ('awaiting_approval', 'queued') ORDER BY created_at, rowid`,
      )
      .all()
      .map(toOutbox)
    const done = this.#db
      .prepare(
        `SELECT * FROM outbox WHERE status NOT IN ('awaiting_approval', 'queued')
         ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(recent)
      .map(toOutbox)
    return [...open, ...done]
  }

  queuedOutbox(): OutboxItem[] {
    return this.#db
      .prepare(`SELECT * FROM outbox WHERE status = 'queued' ORDER BY created_at, rowid`)
      .all()
      .map(toOutbox)
  }

  // ── Host side of copies: idempotent posts and what a copy needs ────────

  /** The stored answer to a post a copy already delivered, so a retry never posts twice. */
  actResult(id: string): { ok: boolean; text: string } | undefined {
    const row = this.#db.prepare('SELECT ok, text FROM acts WHERE id = ?').get(id)
    return row ? { ok: Number(row.ok) === 1, text: String(row.text) } : undefined
  }

  saveAct(id: string, memberId: string, ok: boolean, text: string): void {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO acts (id, member_id, ok, text, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, memberId, ok ? 1 : 0, text, now())
  }

  allMembers(): MemberRecord[] {
    return this.#db
      .prepare(
        'SELECT id, name, role, revoked, created_at, profile FROM members ORDER BY created_at',
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        role: (toMember({ ...row, last_seen: null })?.role ?? 'member') as Role,
        active: Number(row.revoked) === 0,
        createdAt: String(row.created_at),
        profile: row.profile == null ? '' : String(row.profile),
      }))
  }

  // ── Profiles and pinned contracts ──────────────────────────────────────

  setProfile(memberId: string, profile: string): void {
    this.#db.prepare('UPDATE members SET profile = ? WHERE id = ?').run(profile, memberId)
  }

  /** Pins a contract, or replaces it and raises its version. */
  pinContract(input: { name: string; content: string; note: string; updatedBy: string }): Contract {
    const version = (this.contract(input.name)?.version ?? 0) + 1
    this.#db
      .prepare(
        `INSERT INTO contracts (name, content, note, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET content = excluded.content, note = excluded.note,
           version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(input.name, input.content, input.note, version, input.updatedBy, now())
    return this.contract(input.name) as Contract
  }

  contract(name: string): Contract | undefined {
    const row = this.#db.prepare('SELECT * FROM contracts WHERE name = ? COLLATE NOCASE').get(name)
    return row ? toContract(row) : undefined
  }

  contracts(): Contract[] {
    return this.#db.prepare('SELECT * FROM contracts ORDER BY name').all().map(toContract)
  }

  applyContracts(contracts: Contract[]): void {
    const upsert = this.#db.prepare(
      `INSERT OR REPLACE INTO contracts (name, content, note, version, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const c of contracts) {
      upsert.run(c.name, c.content, c.note, c.version, c.updatedBy, c.updatedAt)
    }
  }

  /** A short fingerprint of one event, used to check that a copy and the room share the same history. */
  eventDigest(seq: number): string | undefined {
    const row = this.#db
      .prepare('SELECT ts, author_id, kind, body FROM events WHERE seq = ?')
      .get(seq)
    if (!row) return undefined
    return createHash('sha256')
      .update(`${seq}|${row.ts}|${row.author_id}|${row.kind}|${row.body}`)
      .digest('hex')
      .slice(0, 24)
  }

  // ── Copy side: applying what the room sent ─────────────────────────────

  /** Makes the copy's member list match the room's. Local tokens and read positions are kept. */
  applyMembers(members: MemberRecord[]): void {
    const upsert = this.#db.prepare(
      `INSERT INTO members (id, name, role, token_hash, revoked, created_at, profile) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role,
         revoked = excluded.revoked, profile = excluded.profile`,
    )
    for (const member of members) {
      // Other members' tokens never leave the host; the placeholder can match no real token.
      const placeholder = `none:${randomBytes(16).toString('hex')}`
      upsert.run(
        member.id,
        member.name,
        member.role,
        placeholder,
        member.active ? 0 : 1,
        member.createdAt,
        // A room running an older version sends no profile.
        member.profile ?? '',
      )
    }
  }

  /** Adds events the copy does not have yet, keeping the room's numbering. Returns how many were new. */
  applyEvents(events: RoomEvent[]): number {
    const insert = this.#db.prepare(
      `INSERT OR IGNORE INTO events (seq, ts, author_id, kind, body, reply_to, debate_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let added = 0
    const authors = new Set<string>()
    for (const event of events) {
      const result = insert.run(
        event.seq,
        event.ts,
        event.authorId,
        event.kind,
        event.body,
        event.replyTo,
        event.debateId,
        JSON.stringify(event.data),
      )
      if (Number(result.changes) > 0) {
        added += 1
        authors.add(event.authorId)
      }
    }
    if (added > 0) {
      for (const waiter of [...this.#waiters]) {
        if ([...authors].some((author) => author !== waiter.memberId)) waiter.wake()
      }
    }
    return added
  }

  applyDebates(debates: Debate[]): void {
    const upsert = this.#db.prepare(
      `INSERT OR REPLACE INTO debates (id, question, options, context, opened_by, opened_at, status, max_rounds, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const debate of debates) {
      upsert.run(
        debate.id,
        debate.question,
        JSON.stringify(debate.options),
        debate.context,
        debate.openedBy,
        debate.openedAt,
        debate.status,
        debate.maxRounds,
        debate.decision ? JSON.stringify(debate.decision) : null,
      )
    }
  }

  applyReports(reports: StoredReport[]): void {
    const upsert = this.#db.prepare(
      `INSERT OR REPLACE INTO reports (id, key, debate_id, author, content, notes, from_seq, to_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const report of reports) {
      upsert.run(
        report.id,
        report.key,
        report.debateId,
        report.author,
        JSON.stringify(report.content),
        JSON.stringify(report.notes),
        report.fromSeq,
        report.toSeq,
        report.updatedAt,
      )
    }
  }

  applySettings(settings: Settings): void {
    this.#setValue('room', settings)
  }

  /** The newest report change the copy knows of, to ask the room only for later ones. */
  lastReportUpdate(): string {
    return String(
      this.#db.prepare(`SELECT COALESCE(MAX(updated_at), '') AS t FROM reports`).get()?.t ?? '',
    )
  }

  /** Empties the copied history when it no longer matches the room, so it can be fetched again. */
  resetCopy(meId: string): void {
    this.#db.exec(
      'DELETE FROM events; DELETE FROM debates; DELETE FROM reports; DELETE FROM contracts;',
    )
    this.#db.prepare('DELETE FROM members WHERE id != ?').run(meId)
    this.#db.prepare('UPDATE members SET cursor = 0 WHERE id = ?').run(meId)
  }

  /** Whether the copy's owner already has a token for their own agent. */
  hasLocalToken(memberId: string): boolean {
    const row = this.#db.prepare('SELECT token_hash FROM members WHERE id = ?').get(memberId)
    return row !== undefined && !String(row.token_hash).startsWith('none:')
  }

  /** Gives the copy's owner a token for their own agent to reach this machine's copy. */
  issueLocalToken(memberId: string): string {
    const token = randomBytes(32).toString('base64url')
    this.#db
      .prepare('UPDATE members SET token_hash = ? WHERE id = ?')
      .run(hashToken(token), memberId)
    return token
  }

  /**
   * Turns a copy into the room itself, for when the original host is gone.
   * Its owner becomes the host; everyone else needs a new token from them.
   */
  promoteCopy(meId: string): void {
    this.#db.prepare(`UPDATE members SET role = 'member' WHERE role = 'host'`).run()
    this.#db.prepare(`UPDATE members SET role = 'host', revoked = 0 WHERE id = ?`).run(meId)
    this.#db
      .prepare(
        `UPDATE outbox SET status = 'failed', result = 'Not sent: this copy became the room.', updated_at = ?
         WHERE status IN ('awaiting_approval', 'queued')`,
      )
      .run(now())
    this.#db.prepare(`DELETE FROM settings WHERE key = 'mirror'`).run()
    this.setKind('host')
  }
}

function toOutbox(row: Row): OutboxItem {
  return {
    id: String(row.id),
    action: String(row.action),
    input: parseJson<Record<string, unknown>>(row.input, {}),
    status: String(row.status) as OutboxStatus,
    result: String(row.result),
    human: Number(row.human) === 1,
    debateId: row.debate_id == null ? null : Number(row.debate_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function toMember(row: Row | undefined): Member | undefined {
  if (!row) return undefined
  const role = row.role === 'host' || row.role === 'observer' ? row.role : 'member'
  return {
    id: String(row.id),
    name: String(row.name),
    role,
    lastSeen: row.last_seen == null ? null : String(row.last_seen),
    profile: row.profile == null ? '' : String(row.profile),
  }
}

function toContract(row: Row): Contract {
  return {
    name: String(row.name),
    content: String(row.content),
    note: String(row.note),
    version: Number(row.version),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  }
}

function toEvent(row: Row): RoomEvent {
  return {
    seq: Number(row.seq),
    ts: String(row.ts),
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    kind: String(row.kind) as EventKind,
    body: String(row.body),
    replyTo: row.reply_to == null ? null : Number(row.reply_to),
    debateId: row.debate_id == null ? null : Number(row.debate_id),
    data: parseJson<Record<string, unknown>>(row.data, {}),
  }
}

function toDebate(row: Row): Debate {
  return {
    id: Number(row.id),
    question: String(row.question),
    options: parseJson<string[]>(row.options, []),
    context: String(row.context),
    openedBy: String(row.opened_by),
    openedAt: String(row.opened_at),
    status: String(row.status) as DebateStatus,
    maxRounds: Number(row.max_rounds),
    decision: parseJson<Decision | null>(row.decision, null),
  }
}

function toReport(row: Row | undefined): StoredReport | undefined {
  if (!row) return undefined
  return {
    id: Number(row.id),
    key: String(row.key),
    debateId: row.debate_id == null ? null : Number(row.debate_id),
    author: String(row.author),
    content: parseJson<Record<string, unknown>>(row.content, {}),
    notes: parseJson<ReportNote[]>(row.notes, []),
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    updatedAt: String(row.updated_at),
  }
}
