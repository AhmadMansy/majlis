import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { z } from 'zod'
import { ACTIONS_BY_NAME } from './actions.ts'
import { type ConnectInfo, connectInfo } from './connect.ts'
import type { Outbound } from './outbound.ts'
import { type DebateView, type Room, RoomError } from './room.ts'
import type {
  ApprovalMode,
  DebateStatus,
  Member,
  OutboxItem,
  RoomEvent,
  Settings,
} from './store.ts'
import { normalizeHostUrl, type SyncClient, type SyncStatus } from './sync.ts'

/** What the control panel shows; the panel imports these types. */
export interface AdminState {
  room: { name: string; local: string; public: string | null }
  settings: Settings
  members: Array<Member & { posts: number }>
  debates: Array<{
    id: number
    question: string
    status: DebateStatus
    openedBy: string
    participants: string[]
    positions: number
    proposals: number
  }>
  reports: Array<{
    id: number
    debateId: number | null
    title: string
    author: string
    url: string
    publicUrl: string | null
  }>
  lastSeq: number
  /** Whether this panel belongs to the room's host or to a member's copy. */
  mode: 'host' | 'mirror'
  me: { id: string; name: string; role: Member['role'] } | null
  /** This machine's own settings: never shared with the room. */
  local: { approval: ApprovalMode; deny: string[] }
  outbox: OutboxItem[]
  /** A copy's connection to its room; null on the host. */
  sync: SyncStatus | null
}

export interface AdminEvents {
  events: RoomEvent[]
  lastSeq: number
}

export interface AdminDebate {
  view: DebateView
  record: string | null
}

export interface AdminInvite {
  member: Member
  connect: ConnectInfo
}

export interface AdminServer {
  port: number
  /** Opens the panel already signed in; the key rides in the URL fragment, which is never sent to a server. */
  url: string
  key: string
  close: () => Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}

const settingsPatch = z
  .object({
    paused: z.boolean(),
    debates: z.boolean(),
    reports: z.boolean(),
    maxMessageChars: z.number().int().min(200).max(20000),
    postsPerHour: z.number().int().min(1).max(1000),
    maxRounds: z.number().int().min(1).max(12),
  })
  .partial()
  .strict()

const inviteBody = z.object({
  name: z.string().trim().min(1).max(40),
  role: z.enum(['member', 'observer']).default('member'),
})
const roleBody = z.object({ role: z.enum(['member', 'observer']) })
const messageBody = z.object({
  text: z.string().trim().min(1).max(20000),
  replyTo: z.number().int().positive().nullable().default(null),
})
const decideBody = z.object({
  resolution: z.string().trim().min(10).max(2000),
  rationale: z.string().trim().min(5).max(4000),
  actions: z
    .array(
      z.object({
        owner: z.string().trim().min(1).max(60),
        action: z.string().trim().min(3).max(300),
      }),
    )
    .max(10)
    .default([]),
})

const localPatch = z
  .object({
    approval: z.enum(['every', 'debate', 'auto']),
    deny: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .partial()
  .strict()
const addressBody = z.object({ url: z.string().trim().min(8).max(500) })

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new HttpError(413, 'Request too large.')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'Invalid JSON.')
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new HttpError(400, `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`)
  }
  return result.data
}

export interface AdminServerOptions {
  room: Room
  port: number
  /** Folder with the built panel. Defaults to panel/dist next to src. */
  panelDir?: string
  /** This machine's outbox: approvals, and the human's own messages. */
  outbound: Outbound
  /** On a member's copy: its connection to the room. */
  sync?: SyncClient
}

/**
 * The host's control panel and its API. It listens on its own loopback port
 * that is never tunnelled, checks the Host header against DNS rebinding, and
 * requires a per-run key on every API call.
 */
export async function startAdminServer(options: AdminServerOptions): Promise<AdminServer> {
  const { room } = options
  const { store } = room
  const panelDir = options.panelDir ?? join(import.meta.dirname, '..', 'panel', 'dist')
  const key = randomBytes(24).toString('base64url')
  const keyBytes = Buffer.from(key)

  const mode = store.kind() === 'mirror' ? 'mirror' : 'host'
  const { outbound } = options

  /** The owner of this machine: the host member, or on a copy the member the copy belongs to. */
  const me = (): Member => {
    const config = store.mirrorConfig()
    const member = mode === 'mirror' && config ? store.memberById(config.meId) : store.hostMember()
    if (!member) throw new HttpError(500, 'This machine has no member in the room.')
    return member
  }
  const hostOnly = (): void => {
    if (mode !== 'host') throw new HttpError(403, 'Only the host of the room can do that.')
  }

  const state = (): AdminState => {
    const posts = store.postCounts()
    const local = store.localSettings()
    const self =
      mode === 'mirror' ? store.memberById(store.mirrorConfig()?.meId ?? '') : store.hostMember()
    return {
      mode,
      me: self ? { id: self.id, name: self.name, role: self.role } : null,
      local: { approval: local.approval, deny: local.deny },
      outbox: store.outbox(10),
      sync: options.sync?.status() ?? null,
      room: { name: room.name, local: room.urls.local, public: room.urls.public },
      settings: store.settings(),
      members: store.members().map((member) => ({ ...member, posts: posts[member.id] ?? 0 })),
      debates: store.debates().map((debate) => {
        const view = room.debateView(debate.id)
        return {
          id: debate.id,
          question: debate.question,
          status: debate.status,
          openedBy: view.openedByName,
          participants: view.participants,
          positions: view.positions.length,
          proposals: view.proposals.length,
        }
      }),
      reports: store.reports().map((report) => ({
        id: report.id,
        debateId: report.debateId,
        title:
          typeof report.content.title === 'string' ? report.content.title : `Report ${report.id}`,
        author: report.author,
        url: `${room.urls.local}/r/${report.key}`,
        publicUrl: room.urls.public ? `${room.urls.public}/r/${report.key}` : null,
      })),
      lastSeq: store.lastSeq(),
    }
  }

  const api = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    const path = url.pathname.slice('/api'.length)
    const method = req.method ?? 'GET'
    const id = /^\/(members|debates|outbox)\/([^/]+)/.exec(path)?.[2] ?? ''

    if (method === 'GET' && path === '/state') return state()
    if (method === 'GET' && path === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0)
      const events: AdminEvents = {
        events: store.eventsBetween(Number.isFinite(after) ? after : 0, undefined, 500),
        lastSeq: store.lastSeq(),
      }
      return events
    }
    if (method === 'GET' && /^\/debates\/\d+$/.test(path)) {
      const view = room.debateView(Number(id))
      const debate: AdminDebate = {
        view,
        record: view.debate.decision ? room.decisionRecord(view.debate.id) : null,
      }
      return debate
    }
    if (method !== 'POST') throw new HttpError(404, 'Not found.')

    const body = await readJson(req)

    // ── This machine's own controls: the same on the host and on a copy ──
    if (path === '/messages') {
      const input = parse(messageBody, body)
      const send = ACTIONS_BY_NAME.get('send')
      if (!send) throw new HttpError(500, 'The send action is missing.')
      const text = await outbound.submit(
        me(),
        send,
        { text: input.text, ...(input.replyTo === null ? {} : { reply_to: input.replyTo }) },
        { human: true },
      )
      // A copy shows its owner's message as soon as the room has it, without waiting for the next poll.
      await options.sync?.syncOnce(0).catch(() => undefined)
      return { text }
    }
    if (/^\/outbox\/[^/]+\/approve$/.test(path)) {
      await outbound.approve(id)
      await options.sync?.syncOnce(0).catch(() => undefined)
      return state()
    }
    if (/^\/outbox\/[^/]+\/reject$/.test(path)) {
      outbound.reject(id)
      return state()
    }
    if (path === '/local') {
      const patch = parse(localPatch, body)
      store.updateLocalSettings({
        ...(patch.approval === undefined ? {} : { approval: patch.approval }),
        ...(patch.deny === undefined ? {} : { deny: patch.deny }),
      })
      return state()
    }
    if (path === '/host-address') {
      const config = store.mirrorConfig()
      if (mode !== 'mirror' || !config) throw new HttpError(400, 'This is not a copy of a room.')
      let hostUrl: string
      try {
        hostUrl = normalizeHostUrl(parse(addressBody, body).url)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid address.')
      }
      store.setMirrorConfig({ ...config, hostUrl })
      await options.sync?.syncOnce(0).catch(() => undefined)
      return state()
    }
    if (path === '/me/token') {
      if (mode !== 'mirror') throw new HttpError(400, 'Use "New token" in the member list.')
      const self = me()
      const invite: AdminInvite = {
        member: self,
        connect: connectInfo(room.urls.local, store.issueLocalToken(self.id)),
      }
      return invite
    }

    // ── The room's controls: host only ──
    hostOnly()
    if (path === '/settings') {
      store.updateSettings(parse(settingsPatch, body) as Partial<Settings>)
      return state()
    }
    if (path === '/members') {
      const input = parse(inviteBody, body)
      if (store.nameTaken(input.name)) {
        throw new HttpError(409, `The name "${input.name}" has already been used in this room.`)
      }
      const { member, token } = store.addMember(input.name, input.role)
      const invite: AdminInvite = {
        member,
        connect: connectInfo(room.urls.public ?? room.urls.local, token, true),
      }
      return invite
    }
    if (/^\/members\/[^/]+\/rotate$/.test(path)) {
      const member = store.memberById(id)
      const token = member ? store.rotateToken(member.name) : undefined
      if (!member || !token) throw new HttpError(404, 'No such member.')
      const base = member.role === 'host' ? room.urls.local : (room.urls.public ?? room.urls.local)
      const invite: AdminInvite = {
        member,
        connect: connectInfo(base, token, member.role !== 'host'),
      }
      return invite
    }
    if (/^\/members\/[^/]+\/revoke$/.test(path)) {
      if (!store.revoke(id)) throw new HttpError(400, 'That member cannot be removed.')
      return state()
    }
    if (/^\/members\/[^/]+\/role$/.test(path)) {
      if (!store.setRole(id, parse(roleBody, body).role)) {
        throw new HttpError(400, "That member's role cannot be changed.")
      }
      return state()
    }
    if (/^\/debates\/\d+\/decide$/.test(path)) {
      const input = parse(decideBody, body)
      room.recordHumanDecision(me(), { debateId: Number(id), ...input }, true)
      return state()
    }
    throw new HttpError(404, 'Not found.')
  }

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    if (!existsSync(join(panelDir, 'index.html'))) {
      res
        .writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('The control panel has not been built yet. Run `pnpm build` in the majlis folder.')
      return
    }
    const relative = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, '')
    let file = join(panelDir, relative)
    const inside = file === panelDir || file.startsWith(panelDir + sep)
    if (!inside || !existsSync(file) || !statSync(file).isFile())
      file = join(panelDir, 'index.html')
    res
      .writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://127.0.0.1:*; base-uri 'none'; form-action 'none'",
      })
      .end(readFileSync(file))
  }

  let allowedHosts = new Set<string>()

  const http = createServer((req, res) => {
    // A page on another site cannot reach this server by pointing its own domain at 127.0.0.1.
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden host.')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(res, url.pathname)
      return
    }

    const given = Buffer.from(String(req.headers['x-panel-key'] ?? ''))
    if (given.length !== keyBytes.length || !timingSafeEqual(given, keyBytes)) {
      res
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end('{"error":"Open the panel from the link printed by `majlis host`."}')
      return
    }
    api(req, url).then(
      (result) => {
        res
          .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(result))
      },
      (error: unknown) => {
        const status =
          error instanceof HttpError ? error.status : error instanceof RoomError ? 400 : 500
        const message =
          error instanceof HttpError || error instanceof RoomError
            ? error.message
            : 'Internal error.'
        if (status === 500) console.error(error)
        res
          .writeHead(status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: message }))
      },
    )
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, '127.0.0.1', () => resolve())
  })
  const port = (http.address() as AddressInfo).port
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  return {
    port,
    key,
    url: `http://127.0.0.1:${port}/#key=${key}`,
    close: async () => {
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
