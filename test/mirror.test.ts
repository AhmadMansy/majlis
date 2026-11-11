import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdminState } from '../src/admin.ts'
import { type AdminServer, startAdminServer } from '../src/admin.ts'
import { screen } from '../src/outbound.ts'
import { Room } from '../src/room.ts'
import { RoomStore } from '../src/store.ts'
import { joinRoom } from '../src/sync.ts'
import { openTestCopy, openTestRoom, type TestCopy, type TestRoom, until } from './helpers.ts'

let host: TestRoom
let copy: TestCopy
let opened: TestCopy | undefined
const extra: Array<() => Promise<void>> = []

/** Opens the copy most tests use; it is closed after the test. */
async function openCopy(name: string): Promise<TestCopy> {
  opened = await openTestCopy(host, name)
  return opened
}

beforeEach(async () => {
  host = await openTestRoom(['Omar', 'Sara'])
})

afterEach(async () => {
  for (const close of extra.splice(0)) await close()
  await opened?.close()
  opened = undefined
  await host.close()
})

describe('a member copy', () => {
  it('holds the same conversation as the room and reads it locally', async () => {
    const ahmed = await host.agent('Ahmed')
    await ahmed.call('send', { text: 'Which side should carry the fix?' })
    await ahmed.call('open_debate', { question: 'Unity plugin or Android activity?' })

    copy = await openCopy('Omar')
    expect(copy.store.lastSeq()).toBe(2)
    expect(copy.store.debates()).toHaveLength(1)
    expect(copy.store.members().map((m) => m.name)).toEqual(['Ahmed', 'Omar', 'Sara'])

    const inbox = await copy.agent.call('inbox')
    expect(inbox).toContain('[#1] Ahmed')
    expect(inbox).toContain('Which side should carry the fix?')
    expect(await copy.agent.call('room_status')).toContain('You are: Omar (member)')
    expect(await copy.agent.call('debate_status', { debate_id: 1 })).toContain('Debate #1 · OPEN')
  })

  it('sends its owner posts to the room and receives the others live', async () => {
    copy = await openCopy('Omar')
    copy.sync.start()
    const ahmed = await host.agent('Ahmed')

    expect(await copy.agent.call('send', { text: 'Android here.' })).toBe('Sent as #1.')
    expect(await ahmed.call('inbox')).toContain('[#1] Omar')
    // The owner's own post comes back into the copy promptly, not at the next slow poll.
    await until(() => copy.store.lastSeq() === 1, 2000)

    const waiting = copy.agent.call('wait_for_reply', { timeout_seconds: 20 })
    await ahmed.call('send', { text: 'Unity here.', reply_to: 1 })
    expect(await waiting).toContain('[#2] Ahmed')
  })

  it('runs a whole debate through two copies', async () => {
    copy = await openCopy('Omar')
    const sara = await openTestCopy(host, 'Sara')
    extra.push(sara.close)
    copy.sync.start()
    sara.sync.start()

    await copy.agent.call('open_debate', { question: 'Unity plugin or Android activity?' })
    await copy.agent.call('post_position', {
      debate_id: 1,
      stance: 'Android',
      reasoning: 'The release moved into onPause last month.',
      confidence: 80,
    })
    await until(() => sara.store.lastSeq() === 2)
    const proposed = await sara.agent.call('propose_resolution', {
      debate_id: 1,
      resolution: 'Move the release back to onStop.',
      rationale: 'Both sides see the same ordering problem.',
    })
    const proposal = Number(/#(\d+)/.exec(proposed)?.[1])
    await until(() => copy.store.lastSeq() === 3)

    const accepted = await copy.agent.call('respond_to_resolution', {
      debate_id: 1,
      proposal,
      verdict: 'accept',
    })
    expect(accepted).toContain('Debate #1 is decided')
    await until(() => sara.store.debate(1)?.status === 'decided')
    expect(await sara.agent.call('debate_status', { debate_id: 1 })).toContain(
      'By agreement of Sara, Omar',
    )
  })

  it('keeps working while the host is away and delivers queued posts once, in order', async () => {
    copy = await openCopy('Omar')
    const ahmed = await host.agent('Ahmed')
    await ahmed.call('send', { text: 'Before the outage.' })
    await copy.sync.syncOnce()
    await host.stopServer()

    expect(await copy.agent.call('history')).toContain('Before the outage.')
    const first = await copy.agent.call('send', { text: 'Written offline, one.' })
    expect(first).toContain('will be sent automatically')
    await copy.agent.call('send', { text: 'Written offline, two.' })
    expect(await copy.agent.call('outbox')).toContain('QUEUED until the host is reachable')
    expect(host.store.lastSeq()).toBe(1)

    await host.restartServer()
    copy.sync.start()
    await until(() => host.store.lastSeq() === 3)
    expect(host.store.history(2).map((e) => e.body)).toEqual([
      'Written offline, one.',
      'Written offline, two.',
    ])
    await until(() => copy.store.queuedOutbox().length === 0)
    await copy.outbound.flush()
    expect(host.store.lastSeq()).toBe(3)
    expect(await copy.agent.call('outbox')).toContain('SENT')
  })

  it('does not post twice when the same delivery is repeated', async () => {
    const token = host.tokens.Omar ?? ''
    const body = JSON.stringify({ id: 'retry-0001', action: 'send', input: { text: 'once' } })
    const post = () =>
      fetch(`${host.url}/act`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      }).then((r) => r.json() as Promise<{ ok: boolean; text: string }>)
    expect((await post()).text).toBe('Sent as #1.')
    expect((await post()).text).toBe('Sent as #1.')
    expect(host.store.lastSeq()).toBe(1)
  })

  it('reports a rule the room enforces as an error, without queueing', async () => {
    copy = await openCopy('Omar')
    host.store.updateSettings({ paused: true })
    expect(await copy.agent.fails('send', { text: 'hello' })).toContain('paused')
    expect(copy.store.queuedOutbox()).toHaveLength(0)
  })

  it('fetches the history again when it no longer matches the room', async () => {
    const ahmed = await host.agent('Ahmed')
    await ahmed.call('send', { text: 'one' })
    copy = await openCopy('Omar')

    // The copy ends up with an event the room never had, as after following a different host.
    copy.store.applyEvents([
      {
        seq: 2,
        ts: new Date().toISOString(),
        authorId: copy.store.memberByName('Sara')?.id ?? '',
        authorName: 'Sara',
        kind: 'message',
        body: 'from another history',
        replyTo: null,
        debateId: null,
        data: {},
      },
    ])
    await ahmed.call('send', { text: 'two' })
    await copy.sync.syncOnce()
    expect(copy.store.history(10).map((e) => e.body)).toEqual(['one', 'two'])
  })

  it('can become the room when the host is gone', async () => {
    const ahmed = await host.agent('Ahmed')
    await ahmed.call('send', { text: 'The plan so far.' })
    copy = await openCopy('Omar')
    const meId = copy.store.mirrorConfig()?.meId ?? ''

    copy.store.promoteCopy(meId)
    expect(copy.store.kind()).toBe('host')
    expect(copy.store.hostMember()?.name).toBe('Omar')
    expect(copy.store.memberByName('Ahmed')?.role).toBe('member')
    expect(copy.store.history(5).map((e) => e.body)).toEqual(['The plan so far.'])

    // The new host gives the others fresh tokens; old ones do not work against it.
    const room = new Room(copy.store, 'test')
    const fresh = copy.store.rotateToken('Sara') ?? ''
    expect(copy.store.memberByToken(fresh)?.name).toBe('Sara')
    expect(copy.store.memberByToken(host.tokens.Sara ?? '')).toBeUndefined()
    expect(room.send(copy.store.hostMember() ?? ahmedMember(), 'Carrying on here.', null).seq).toBe(
      2,
    )
  })

  it('refuses to join a folder that hosts a room or copies another member', async () => {
    await expect(joinRoom(host.store, host.url, host.tokens.Omar ?? '')).rejects.toThrow(
      'room you host',
    )
    const store = new RoomStore(':memory:')
    await joinRoom(store, host.url, host.tokens.Omar ?? '')
    await expect(joinRoom(store, host.url, host.tokens.Sara ?? '')).rejects.toThrow(
      'different room or member',
    )
    await expect(joinRoom(new RoomStore(':memory:'), host.url, 'bad-token')).rejects.toThrow(
      'rejected the token',
    )
    store.close()
  })
})

function ahmedMember() {
  const member = host.store.hostMember()
  if (!member) throw new Error('no host')
  return member
}

describe('approval before posting', () => {
  it('holds a post until the human approves it', async () => {
    copy = await openCopy('Omar')
    copy.store.updateLocalSettings({ approval: 'every' })

    const sending = copy.agent.call('send', { text: 'May I say this?' })
    await until(() => copy.store.outbox().some((item) => item.status === 'awaiting_approval'))
    expect(host.store.lastSeq()).toBe(0)

    const held = copy.store.outbox()[0]
    await copy.outbound.approve(held?.id ?? '')
    expect(await sending).toBe('Sent as #1.')
    expect(host.store.history(1)[0]?.body).toBe('May I say this?')
  })

  it('tells the agent when the human declines', async () => {
    host.store.updateLocalSettings({ approval: 'every' })
    const ahmed = await host.agent('Ahmed')
    const sending = ahmed.fails('send', { text: 'Not this one.' })
    await until(() => host.store.outbox().length === 1)
    host.outbound.reject(host.store.outbox()[0]?.id ?? '')
    expect(await sending).toContain('declined')
    expect(host.store.lastSeq()).toBe(0)
  })

  it('leaves the post held when nobody answers in time, and sends it on a later approval', async () => {
    host.store.updateLocalSettings({ approval: 'every' })
    const hostMember = ahmedMember()
    const send = (await import('../src/actions.ts')).ACTIONS_BY_NAME.get('send')
    if (!send) throw new Error('send action missing')
    const result = await host.outbound.submit(hostMember, send, { text: 'Later.' }, { waitMs: 50 })
    expect(result).toContain('has not approved this post yet')
    expect(host.store.lastSeq()).toBe(0)

    const item = host.store.outbox()[0]
    await host.outbound.approve(item?.id ?? '')
    expect(host.store.history(1)[0]?.body).toBe('Later.')
    expect(host.outbound.describe()).toContain('SENT')
  })

  it('asks once per debate in debate mode', async () => {
    host.store.updateLocalSettings({ approval: 'debate' })
    const ahmed = await host.agent('Ahmed')

    const opening = ahmed.call('open_debate', { question: 'Unity plugin or Android activity?' })
    await until(() => host.store.outbox().length === 1)
    await host.outbound.approve(host.store.outbox()[0]?.id ?? '')
    expect(await opening).toContain('Opened debate #1')

    // Inside the approved debate the agent posts freely.
    expect(
      await ahmed.call('post_position', {
        debate_id: 1,
        stance: 'Android',
        reasoning: 'The surface is released too early.',
        confidence: 70,
      }),
    ).toContain('Posted as #2')

    // A free message is not part of that debate and still needs the human.
    const free = ahmed.call('send', { text: 'Unrelated note.' })
    await until(() => host.store.outbox().some((item) => item.status === 'awaiting_approval'))
    const held = host.store.outbox().find((item) => item.status === 'awaiting_approval')
    await host.outbound.approve(held?.id ?? '')
    expect(await free).toBe('Sent as #3.')
  })

  it('does not gate other members who connect straight to the host', async () => {
    host.store.updateLocalSettings({ approval: 'every' })
    const omar = await host.agent('Omar')
    expect(await omar.call('send', { text: 'Direct member.' })).toBe('Sent as #1.')
  })
})

describe('what must not leave the machine', () => {
  it('stops credentials and blocked text before anything is stored or sent', async () => {
    copy = await openCopy('Omar')
    copy.store.updateLocalSettings({ deny: ['internal-billing', 'secrets/*.json'] })

    expect(
      await copy.agent.fails('send', { text: 'key is AKIAABCDEFGHIJKLMNOP for the bucket' }),
    ).toContain('an AWS access key')
    expect(
      await copy.agent.fails('post_position', {
        debate_id: 1,
        stance: 'x',
        reasoning: 'See the Internal-Billing service for details.',
        confidence: 50,
      }),
    ).toContain('"internal-billing"')
    expect(await copy.agent.fails('send', { text: 'look at secrets/prod.json' })).toContain(
      'secrets/*.json',
    )

    expect(copy.store.outbox()).toHaveLength(0)
    expect(host.store.lastSeq()).toBe(0)
  })

  it('never repeats the secret in its explanation', () => {
    const secret = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${'A'.repeat(40)}`
    try {
      screen({ text: secret }, [])
      throw new Error('expected a refusal')
    } catch (error) {
      expect(String(error)).toContain('a private key')
      expect(String(error)).not.toContain('MIIEow')
    }
  })
})

describe('the panel on a copy', () => {
  let admin: AdminServer
  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const response = await fetch(`http://127.0.0.1:${admin.port}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Panel-Key': admin.key,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, data: (await response.json()) as T }
  }

  beforeEach(async () => {
    copy = await openCopy('Omar')
    admin = await startAdminServer({
      room: copy.room,
      port: 0,
      panelDir: 'does-not-exist',
      outbound: copy.outbound,
      sync: copy.sync,
    })
    extra.push(admin.close)
  })

  it('shows the copy owner, the connection and no host powers', async () => {
    const state = await call<AdminState>('/state')
    expect(state.data.mode).toBe('mirror')
    expect(state.data.me?.name).toBe('Omar')
    expect(state.data.sync?.online).toBe(true)

    expect((await call('/settings', { paused: true })).status).toBe(403)
    expect((await call('/members', { name: 'Mallory' })).status).toBe(403)
    expect(host.store.settings().paused).toBe(false)
  })

  it('lets the human approve a held post and write without approval', async () => {
    copy.store.updateLocalSettings({ approval: 'every' })
    const sending = copy.agent.call('send', { text: 'From the agent.' })
    await until(() => copy.store.outbox().length === 1)

    const state = await call<AdminState>('/state')
    const held = state.data.outbox.find((item) => item.status === 'awaiting_approval')
    expect(held?.input.text).toBe('From the agent.')
    expect((await call(`/outbox/${held?.id}/approve`, {})).status).toBe(200)
    expect(await sending).toBe('Sent as #1.')

    expect((await call('/messages', { text: 'From Omar himself.' })).status).toBe(200)
    const last = host.store.history(1)[0]
    expect(last?.body).toBe('From Omar himself.')
    expect(last?.data.via).toBe('human')
    expect(copy.store.lastSeq()).toBe(2)
  })

  it('changes local settings and the room address without touching the room', async () => {
    const changed = await call<AdminState>('/local', { approval: 'debate', deny: ['.env'] })
    expect(changed.data.local).toEqual({ approval: 'debate', deny: ['.env'] })
    expect(host.store.localSettings().approval).toBe('auto')

    const moved = await call<AdminState>('/host-address', { url: `${host.url}/mcp/` })
    expect(moved.data.sync?.hostUrl).toBe(host.url)
    expect((await call('/host-address', { url: 'not a url' })).status).toBe(400)
  })
})
