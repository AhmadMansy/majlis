import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdminInvite, AdminState } from '../src/admin.ts'
import { type AdminServer, startAdminServer } from '../src/admin.ts'
import { legacyPost, openTestRoom, type TestRoom } from './helpers.ts'

let t: TestRoom
let admin: AdminServer
let base: string

async function call<T>(
  path: string,
  body?: unknown,
  key = admin.key,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Panel-Key': key,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, data: (await response.json()) as T }
}

/** A request whose Host header names another site, as a DNS-rebinding page would send. */
function statusWithHost(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: admin.port,
        path: '/api/state',
        headers: { Host: host, 'X-Panel-Key': admin.key },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  t = await openTestRoom()
  admin = await startAdminServer({
    room: t.room,
    port: 0,
    panelDir: 'does-not-exist',
    outbound: t.outbound,
  })
  base = `http://127.0.0.1:${admin.port}`
})

afterEach(async () => {
  await admin.close()
  await t.close()
})

describe('control panel access', () => {
  it('requires the panel key', async () => {
    expect((await call('/state', undefined, 'wrong')).status).toBe(401)
    expect((await call('/state', undefined, '')).status).toBe(401)
    expect((await call('/state')).status).toBe(200)
  })

  it('rejects requests addressed to another host name', async () => {
    expect(await statusWithHost('evil.example')).toBe(403)
    expect(await statusWithHost(`127.0.0.1:${admin.port}`)).toBe(200)
  })

  it('says how to build the panel when it has not been built', async () => {
    const response = await fetch(base)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('pnpm build')
  })
})

describe('control panel actions', () => {
  it('invites a member whose token then works, and removes them again', async () => {
    const invited = await call<AdminInvite>('/members', { name: 'Sara', role: 'observer' })
    expect(invited.status).toBe(200)
    expect(invited.data.member.role).toBe('observer')
    const token = /Bearer ([A-Za-z0-9_-]+)/.exec(invited.data.connect.claude)?.[1] ?? ''
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await legacyPost(t.endpoint, token, list)).status).toBe(200)

    expect((await call('/members', { name: 'Sara' })).status).toBe(409)

    const removed = await call<AdminState>(`/members/${invited.data.member.id}/revoke`, {})
    expect(removed.data.members.map((m) => m.name)).toEqual(['Ahmed', 'Omar'])
    expect((await legacyPost(t.endpoint, token, list)).status).toBe(401)
  })

  it('will not remove the host', async () => {
    const hostId = t.store.hostMember()?.id ?? ''
    expect((await call(`/members/${hostId}/revoke`, {})).status).toBe(400)
  })

  it('changes room rules and rejects unknown or out-of-range ones', async () => {
    const paused = await call<AdminState>('/settings', { paused: true, maxRounds: 2 })
    expect(paused.data.settings).toMatchObject({ paused: true, maxRounds: 2 })
    expect((await call('/settings', { maxRounds: 0 })).status).toBe(400)
    expect((await call('/settings', { somethingElse: true })).status).toBe(400)

    const omar = await t.agent('Omar')
    expect(await omar.fails('send', { text: 'hello' })).toContain('paused')
  })

  it('lets the host write as a human even while the room is paused', async () => {
    t.store.updateSettings({ paused: true })
    expect((await call('/messages', { text: 'Pausing for lunch.' })).status).toBe(200)
    const omar = await t.agent('Omar')
    const inbox = await omar.call('inbox')
    expect(inbox).toContain('typed by the human')
    expect(inbox).toContain('Pausing for lunch.')
  })

  it('records the humans decision on an escalated debate', async () => {
    const omar = await t.agent('Omar')
    await omar.call('open_debate', { question: 'Which team owns the push payload format?' })
    await omar.call('escalate_debate', {
      debate_id: 1,
      crux: 'Both formats work; it is a question of ownership.',
      question: 'Who owns the format?',
    })
    const decided = await call<AdminState>('/debates/1/decide', {
      resolution: 'The Android team owns the payload format.',
      rationale: 'They ship the receiver.',
    })
    expect(decided.data.debates[0]?.status).toBe('decided')
    expect(await omar.call('debate_status', { debate_id: 1 })).toContain(
      'By the humans, recorded by Ahmed',
    )
  })

  it('serves new events after a given number', async () => {
    const omar = await t.agent('Omar')
    await omar.call('send', { text: 'one' })
    await omar.call('send', { text: 'two' })
    const events = await call<{ events: Array<{ seq: number; body: string }>; lastSeq: number }>(
      '/events?after=1',
    )
    expect(events.data.events.map((e) => e.body)).toEqual(['two'])
    expect(events.data.lastSeq).toBe(2)
  })
})
