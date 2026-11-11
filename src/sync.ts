import { z } from 'zod'
import { ACTIONS_BY_NAME } from './actions.ts'
import { type Room, RoomError } from './room.ts'
import type {
  Debate,
  Member,
  MemberRecord,
  RoomEvent,
  RoomStore,
  Settings,
  StoredReport,
} from './store.ts'

/** What the room sends a member's copy: everything new since the copy's last event. */
export interface SyncResponse {
  room: string
  /** True when the copy's history does not match the room's and must be fetched again from the start. */
  reset: boolean
  you: { id: string; name: string; role: Member['role'] }
  members: MemberRecord[]
  settings: Settings
  events: RoomEvent[]
  debates: Debate[]
  reports: StoredReport[]
  lastSeq: number
}

const BATCH = 500
const MAX_WAIT_SECONDS = 25

// ── Host side ──────────────────────────────────────────────────────────────

/** Answers a copy's request for news, holding it open briefly when there is none yet. */
export async function handleSync(
  room: Room,
  member: Member,
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<SyncResponse> {
  const { store } = room
  const after = Math.max(0, Math.trunc(Number(params.get('after') ?? 0)) || 0)
  const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(params.get('wait') ?? 0) || 0))
  // A copy whose last event is not the room's event of that number followed another history.
  const reset = after > 0 && store.eventDigest(after) !== (params.get('check') ?? '')
  const from = reset ? 0 : after

  let events = store.eventsBetween(from, undefined, BATCH)
  if (events.length === 0 && !reset && wait > 0) {
    // Wake for anyone's post, the member's own included: a copy shows its owner's posts too.
    await store.waitForEvent(wait * 1000, signal)
    events = store.eventsBetween(from, undefined, BATCH)
  }
  return {
    room: room.name,
    reset,
    you: { id: member.id, name: member.name, role: member.role },
    members: store.allMembers(),
    settings: store.settings(),
    events,
    debates: store.debates(),
    reports: store.reportsSince(reset ? '' : (params.get('reports') ?? '')),
    lastSeq: store.lastSeq(),
  }
}

const actBody = z.object({
  id: z.string().min(8).max(64),
  action: z.string().min(1).max(60),
  input: z.record(z.string(), z.unknown()),
  human: z.boolean().default(false),
})

export interface ActResponse {
  ok: boolean
  text?: string
  error?: string
}

/** Applies a post sent by a member's copy. A repeated id returns the first answer instead of posting again. */
export function handleAct(room: Room, member: Member, body: unknown): ActResponse {
  const parsed = actBody.safeParse(body)
  if (!parsed.success) return { ok: false, error: 'Malformed request from the copy.' }
  const { id, action: name, input, human } = parsed.data
  const { store } = room

  const before = store.actResult(id)
  if (before) return before.ok ? { ok: true, text: before.text } : { ok: false, error: before.text }

  const action = ACTIONS_BY_NAME.get(name)
  if (!action) return { ok: false, error: `Unknown action "${name}".` }
  try {
    // "Typed by the human" is the member's own label for their own message; it grants nothing else.
    const text = action.run(room, member, input, human && name === 'send')
    store.saveAct(id, member.id, true, text)
    return { ok: true, text }
  } catch (error) {
    if (!(error instanceof RoomError)) throw error
    store.saveAct(id, member.id, false, error.message)
    return { ok: false, error: error.message }
  }
}

// ── Copy side ──────────────────────────────────────────────────────────────

export interface SyncStatus {
  online: boolean
  lastSyncAt: string | null
  error: string | null
  hostUrl: string
}

async function request(
  hostUrl: string,
  token: string,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<SyncResponse> {
  let response: Response
  try {
    response = await fetch(`${hostUrl}/sync?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
  } catch {
    throw new Error('The host cannot be reached.')
  }
  if (response.status === 401) {
    throw new Error('The room rejected the token. Ask the host for a new one.')
  }
  if (!response.ok) throw new Error(`The host answered with status ${response.status}.`)
  const data = (await response.json().catch(() => null)) as SyncResponse | null
  if (!data || !Array.isArray(data.events) || !data.you) {
    throw new Error('The address did not answer like a Majlis room.')
  }
  return data
}

/** One request from scratch, used when joining to learn the room's name and who the token belongs to. */
export function probe(hostUrl: string, token: string): Promise<SyncResponse> {
  return request(hostUrl, token, new URLSearchParams({ after: '0' }), AbortSignal.timeout(30_000))
}

/** `https://x.trycloudflare.com/mcp/` and similar are accepted and reduced to the room's base address. */
export function normalizeHostUrl(input: string): string {
  const url = new URL(input.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The room address must start with https:// or http://.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '')}`
}

/**
 * Connects a store to a room as that member's copy and fetches the first batch.
 * Safe to call again on an existing copy, for example with a new address or token.
 */
export async function joinRoom(
  store: RoomStore,
  hostUrl: string,
  token: string,
): Promise<{ room: string; me: SyncResponse['you'] }> {
  if (store.kind() === 'host') {
    throw new Error('This folder holds a room you host. Use another --room name for the copy.')
  }
  const url = normalizeHostUrl(hostUrl)
  const first = await probe(url, token)
  const existing = store.mirrorConfig()
  if (existing && existing.meId !== first.you.id) {
    throw new Error(
      'This folder is a copy of a different room or member. Use another --room name for this one.',
    )
  }
  store.setKind('mirror')
  store.setMirrorConfig({ hostUrl: url, token, meId: first.you.id, room: first.room })
  await new SyncClient(store).syncOnce(0)
  return { room: first.room, me: first.you }
}

/** Keeps a member's copy up to date with the room for as long as it runs. */
export class SyncClient {
  readonly #store: RoomStore
  readonly #onSynced: () => void | Promise<void>
  readonly #abort = new AbortController()
  #online = false
  #lastSyncAt: string | null = null
  #error: string | null = null
  #running = false

  constructor(store: RoomStore, onSynced: () => void | Promise<void> = () => {}) {
    this.#store = store
    this.#onSynced = onSynced
  }

  status(): SyncStatus {
    return {
      online: this.#online,
      lastSyncAt: this.#lastSyncAt,
      error: this.#error,
      hostUrl: this.#store.mirrorConfig()?.hostUrl ?? '',
    }
  }

  /** Fetches and applies one batch. Returns how many events the room still has beyond it. */
  async syncOnce(waitSeconds = 0): Promise<number> {
    const config = this.#store.mirrorConfig()
    if (!config) throw new Error('This copy is not connected to a room.')
    const after = this.#store.lastSeq()
    const params = new URLSearchParams({
      after: String(after),
      check: this.#store.eventDigest(after) ?? '',
      reports: this.#store.lastReportUpdate(),
      wait: String(waitSeconds),
    })
    const signal = AbortSignal.any([
      AbortSignal.timeout((waitSeconds + 20) * 1000),
      this.#abort.signal,
    ])
    const data = await request(config.hostUrl, config.token, params, signal)
    if (data.you.id !== config.meId) {
      throw new Error('That address is a different room than the one this copy belongs to.')
    }

    if (data.reset) this.#store.resetCopy(config.meId)
    this.#store.applyMembers(data.members)
    this.#store.applySettings(data.settings)
    this.#store.applyEvents(data.events)
    this.#store.applyDebates(data.debates)
    this.#store.applyReports(data.reports)

    this.#online = true
    this.#error = null
    this.#lastSyncAt = new Date().toISOString()
    return data.lastSeq - this.#store.lastSeq()
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    void this.#loop()
  }

  stop(): void {
    this.#running = false
    this.#abort.abort()
  }

  async #loop(): Promise<void> {
    let delay = 1000
    while (this.#running) {
      try {
        // Hold the request open only once connected, so a dead address is noticed quickly,
        // and never while posts are waiting to go out: they are sent right after this returns.
        const idle = this.#online && this.#store.queuedOutbox().length === 0
        const behind = await this.syncOnce(idle ? 20 : 0)
        delay = 1000
        await this.#onSynced()
        if (behind <= 0) await new Promise((resolve) => setTimeout(resolve, 250))
      } catch (error) {
        if (!this.#running) break
        this.#online = false
        this.#error = error instanceof Error ? error.message : String(error)
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 20_000)
      }
    }
  }
}
