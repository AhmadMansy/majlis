import { ACTIONS_BY_NAME, type RoomAction } from './actions.ts'
import { type Room, RoomError } from './room.ts'
import type { Member, MirrorConfig, OutboxItem, RoomStore } from './store.ts'

/** The room could not be reached; the post is kept and tried again later. */
export class OfflineError extends Error {}

/** Applies a post in the room: directly on the host, over HTTP from a member's copy. */
export interface Poster {
  post: (member: Member, item: OutboxItem) => Promise<string>
}

export class LocalPoster implements Poster {
  readonly #room: Room
  constructor(room: Room) {
    this.#room = room
  }

  async post(member: Member, item: OutboxItem): Promise<string> {
    const action = ACTIONS_BY_NAME.get(item.action)
    if (!action) throw new RoomError(`Unknown action "${item.action}".`)
    return action.run(this.#room, member, item.input, item.human)
  }
}

export class RemotePoster implements Poster {
  readonly #config: () => MirrorConfig | undefined
  constructor(config: () => MirrorConfig | undefined) {
    this.#config = config
  }

  async post(_member: Member, item: OutboxItem): Promise<string> {
    const config = this.#config()
    if (!config) throw new OfflineError('This copy is not connected to a room.')
    let response: Response
    try {
      response = await fetch(`${config.hostUrl}/act`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        // The item id lets the host recognise a retry and answer it without posting twice.
        body: JSON.stringify({
          id: item.id,
          action: item.action,
          input: item.input,
          human: item.human,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new OfflineError('The host cannot be reached.')
    }
    if (response.status === 401) {
      throw new OfflineError("The room rejected this copy's token. Ask the host for a new one.")
    }
    if (!response.ok) throw new OfflineError(`The host answered with status ${response.status}.`)
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean
      text?: string
      error?: string
    } | null
    if (!data || typeof data.ok !== 'boolean') {
      throw new OfflineError('The address did not answer like a Majlis room.')
    }
    if (!data.ok) throw new RoomError(data.error ?? 'The room refused this post.')
    return data.text ?? ''
  }
}

/** The outbox of the machine that hosts the room: its owner is the host member. */
export function hostOutbound(room: Room): Outbound {
  return new Outbound(room.store, new LocalPoster(room), () => room.store.hostMember())
}

/** The outbox of a member's copy: posts travel to the host. */
export function copyOutbound(store: RoomStore): Outbound {
  return new Outbound(store, new RemotePoster(() => store.mirrorConfig()), () => {
    const config = store.mirrorConfig()
    return config ? store.memberById(config.meId) : undefined
  })
}

// ── What must never leave this machine ─────────────────────────────────────

const SECRET_SHAPES: Array<[string, RegExp]> = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an API key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a signed token (JWT)', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
]

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) strings(item, out)
  return out
}

function denyMatcher(pattern: string): (text: string) => boolean {
  if (!pattern.includes('*')) {
    const needle = pattern.toLowerCase()
    return (text) => text.toLowerCase().includes(needle)
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^\\s]*')
  const regex = new RegExp(escaped, 'i')
  return (text) => regex.test(text)
}

/** Stops a post that carries a credential or something the user has blocked. Never echoes the secret. */
export function screen(input: unknown, deny: string[]): void {
  const texts = strings(input)
  for (const [label, shape] of SECRET_SHAPES) {
    if (texts.some((text) => shape.test(text))) {
      throw new RoomError(
        `This post was stopped on your user's machine because it appears to contain ${label}. ` +
          'Remove it and post again; never share credentials in the room.',
      )
    }
  }
  for (const pattern of deny.map((line) => line.trim()).filter(Boolean)) {
    const matches = denyMatcher(pattern)
    if (texts.some(matches)) {
      throw new RoomError(
        `This post was stopped on your user's machine: it mentions "${pattern}", which they have ` +
          'blocked from leaving this machine. Rephrase without it, or ask them to allow it.',
      )
    }
  }
}

export interface SubmitOptions {
  /** Typed by the human in the panel: needs no approval. */
  human?: boolean
  signal?: AbortSignal
  /** How long to hold the call open for the human's approval. */
  waitMs?: number
}

const short = (id: string): string => id.slice(0, 8)

/**
 * The single way a post by this machine's own agent or human leaves the
 * machine: screened, approved by the human when the local setting asks for
 * it, delivered, and kept in the outbox when the room cannot be reached.
 */
export class Outbound {
  readonly #store: RoomStore
  readonly #poster: Poster
  readonly #me: () => Member | undefined
  readonly #waiting = new Map<string, (item: OutboxItem) => void>()
  #flushing = false

  constructor(store: RoomStore, poster: Poster, me: () => Member | undefined) {
    this.#store = store
    this.#poster = poster
    this.#me = me
  }

  /** Whether this member is the owner of this machine, whose posts pass through the outbox. */
  isLocal(member: Member): boolean {
    return this.#me()?.id === member.id
  }

  async submit(
    member: Member,
    action: RoomAction,
    input: Record<string, unknown>,
    options: SubmitOptions = {},
  ): Promise<string> {
    const local = this.#store.localSettings()
    screen(input, local.deny)

    const human = options.human === true
    const debateId = typeof input.debate_id === 'number' ? input.debate_id : null
    const needsApproval =
      !human &&
      (local.approval === 'every' ||
        (local.approval === 'debate' &&
          !(debateId !== null && local.approvedDebates.includes(debateId))))

    const item = this.#store.addOutbox({
      action: action.name,
      input,
      status: needsApproval ? 'awaiting_approval' : 'queued',
      human,
      debateId,
    })
    const final = needsApproval
      ? await this.#awaitDecision(item, options.waitMs ?? 45_000, options.signal)
      : await this.#deliver(member, item)
    return this.#outcome(final)
  }

  /** The human approved a held post: it is delivered now. */
  async approve(id: string): Promise<OutboxItem> {
    const item = this.#store.outboxItem(id)
    const me = this.#me()
    if (item?.status !== 'awaiting_approval' || !me) {
      throw new RoomError('That post is not waiting for approval.')
    }
    const local = this.#store.localSettings()
    if (
      local.approval === 'debate' &&
      item.debateId !== null &&
      !local.approvedDebates.includes(item.debateId)
    ) {
      this.#store.updateLocalSettings({
        approvedDebates: [...local.approvedDebates, item.debateId],
      })
    }
    const final = await this.#deliver(me, item)
    this.#waiting.get(id)?.(final)
    return final
  }

  reject(id: string): OutboxItem {
    const item = this.#store.outboxItem(id)
    if (item?.status !== 'awaiting_approval') {
      throw new RoomError('That post is not waiting for approval.')
    }
    const final = this.#store.setOutbox(id, 'rejected', 'Declined by the user.') as OutboxItem
    this.#waiting.get(id)?.(final)
    return final
  }

  /** Sends posts saved while the room was unreachable, oldest first, stopping if it still is. */
  async flush(): Promise<void> {
    const me = this.#me()
    if (this.#flushing || !me) return
    this.#flushing = true
    try {
      for (const item of this.#store.queuedOutbox()) {
        const final = await this.#deliver(me, item)
        if (final.status === 'queued') break
      }
    } finally {
      this.#flushing = false
    }
  }

  /** The outbox as the agent reads it. */
  describe(): string {
    const items = this.#store.outbox(5)
    if (items.length === 0) return 'Nothing is held or queued, and nothing was sent recently.'
    const label: Record<OutboxItem['status'], string> = {
      awaiting_approval: 'WAITING for your user to approve it',
      queued: 'QUEUED until the host is reachable',
      sent: 'SENT',
      failed: 'REFUSED by the room',
      rejected: 'DECLINED by your user',
    }
    return items
      .map(
        (item) =>
          `- item ${short(item.id)} · ${item.action} · ${label[item.status]}` +
          (item.result ? `\n  ${item.result.replaceAll('\n', '\n  ')}` : ''),
      )
      .join('\n')
  }

  async #deliver(member: Member, item: OutboxItem): Promise<OutboxItem> {
    try {
      const text = await this.#poster.post(member, item)
      if (item.action === 'open_debate' && this.#store.localSettings().approval === 'debate') {
        const opened = Number(/debate #(\d+)/.exec(text)?.[1])
        const local = this.#store.localSettings()
        if (opened && !local.approvedDebates.includes(opened)) {
          this.#store.updateLocalSettings({ approvedDebates: [...local.approvedDebates, opened] })
        }
      }
      return this.#store.setOutbox(item.id, 'sent', text) as OutboxItem
    } catch (error) {
      if (error instanceof OfflineError) {
        return this.#store.setOutbox(item.id, 'queued', error.message) as OutboxItem
      }
      if (error instanceof RoomError) {
        return this.#store.setOutbox(item.id, 'failed', error.message) as OutboxItem
      }
      throw error
    }
  }

  #awaitDecision(item: OutboxItem, waitMs: number, signal?: AbortSignal): Promise<OutboxItem> {
    return new Promise((resolve) => {
      const finish = (final: OutboxItem) => {
        clearTimeout(timer)
        this.#waiting.delete(item.id)
        signal?.removeEventListener('abort', onGiveUp)
        resolve(final)
      }
      // If nobody decides in time the post simply stays held; approving it later still sends it.
      const onGiveUp = () => finish(this.#store.outboxItem(item.id) ?? item)
      const timer = setTimeout(onGiveUp, waitMs)
      signal?.addEventListener('abort', onGiveUp, { once: true })
      this.#waiting.set(item.id, finish)
    })
  }

  #outcome(item: OutboxItem): string {
    switch (item.status) {
      case 'sent':
        return item.result
      case 'queued':
        return (
          `The room's host cannot be reached right now. Your post is saved on this machine as item ` +
          `${short(item.id)} and will be sent automatically when the host is back. Do not post it again; ` +
          'call outbox later to see the result.'
        )
      case 'awaiting_approval':
        return (
          `Your user has not approved this post yet. It is held on this machine as item ${short(item.id)}. ` +
          'Ask them to approve it in their Majlis panel, then call outbox to see the result. Do not post it again.'
        )
      case 'rejected':
        throw new RoomError(
          'Your user declined this post. Do not post it again unless they ask you to.',
        )
      case 'failed':
        throw new RoomError(item.result)
    }
  }
}
