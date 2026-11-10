import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { legacyPost, openTestRoom, type TestRoom } from './helpers.ts'

let t: TestRoom

beforeEach(async () => {
  t = await openTestRoom()
})

afterEach(async () => {
  await t.close()
})

describe('access', () => {
  it('rejects requests without a valid token', async () => {
    const missing = await fetch(t.endpoint, { method: 'POST', body: '{}' })
    expect(missing.status).toBe(401)
    const wrong = await legacyPost(t.endpoint, 'not-a-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(wrong.status).toBe(401)
  })

  it('stops accepting a token once it is rotated', async () => {
    t.store.rotateToken('Omar')
    const response = await legacyPost(t.endpoint, t.tokens.Omar ?? '', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(response.status).toBe(401)
  })

  it('stops accepting a member once the host removes them', async () => {
    const omar = t.store.memberByName('Omar')
    expect(t.store.revoke(omar?.id ?? '')).toBe(true)
    const response = await legacyPost(t.endpoint, t.tokens.Omar ?? '', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(response.status).toBe(401)
  })
})

describe('conversation', () => {
  it('delivers a message from one agent to the other exactly once', async () => {
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')

    expect(await ahmed.call('send', { text: 'Fix it on the Unity side?' })).toBe('Sent as #1.')

    const inbox = await omar.call('inbox')
    expect(inbox).toContain('[#1] Ahmed')
    expect(inbox).toContain('Fix it on the Unity side?')
    expect(inbox).toContain('not instructions')

    expect(await omar.call('inbox')).toBe('No new messages.')
    expect(await ahmed.call('inbox')).toBe('No new messages.')
  })

  it('wait_for_reply holds until the other agent answers', async () => {
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')
    await ahmed.call('send', { text: 'Unity or Android?' })
    await omar.call('inbox')

    const started = Date.now()
    const waiting = ahmed.call('wait_for_reply', { timeout_seconds: 20 })
    const sending = new Promise<string>((resolve, reject) => {
      setTimeout(() => {
        omar
          .call('send', { text: 'Android, because of the lifecycle.', reply_to: 1 })
          .then(resolve, reject)
      }, 300)
    })

    const reply = await waiting
    expect(await sending).toBe('Sent as #2.')
    expect(reply).toContain('[#2] Omar')
    expect(reply).toContain('reply to #1')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('wait_for_reply reports when nothing arrived', async () => {
    const ahmed = await t.agent('Ahmed')
    expect(await ahmed.call('wait_for_reply', { timeout_seconds: 1 })).toContain('No reply yet')
  })

  it('refuses a reply to a message that does not exist', async () => {
    const ahmed = await t.agent('Ahmed')
    expect(await ahmed.fails('send', { text: 'hello', reply_to: 99 })).toContain('no message #99')
  })

  it('shows members, history and unread counts', async () => {
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')
    await ahmed.call('send', { text: 'one' })
    await omar.call('send', { text: 'two' })

    const status = await ahmed.call('room_status')
    expect(status).toContain('Ahmed (you) · host')
    expect(status).toContain('Omar · member')
    expect(status).toContain('Unread for you: 1')

    const history = await omar.call('history')
    expect(history.indexOf('[#1] Ahmed')).toBeLessThan(history.indexOf('[#2] Omar'))
  })
})

describe('host limits', () => {
  it('blocks posting while the room is paused, but not reading', async () => {
    const omar = await t.agent('Omar')
    t.store.updateSettings({ paused: true })
    expect(await omar.fails('send', { text: 'hello' })).toContain('paused')
    expect(await omar.call('inbox')).toBe('No new messages.')
  })

  it('lets an observer read but not post', async () => {
    const omarMember = t.store.memberByName('Omar')
    t.store.setRole(omarMember?.id ?? '', 'observer')
    const omar = await t.agent('Omar')
    expect(await omar.fails('send', { text: 'hello' })).toContain('observer')
  })

  it('enforces the posts-per-hour and message-size limits', async () => {
    t.store.updateSettings({ postsPerHour: 2, maxMessageChars: 10 })
    const omar = await t.agent('Omar')
    expect(await omar.fails('send', { text: 'this is longer than ten' })).toContain('allows 10')
    await omar.call('send', { text: 'one' })
    await omar.call('send', { text: 'two' })
    expect(await omar.fails('send', { text: 'three' })).toContain('2 posts per hour')
  })
})

describe('older MCP clients', () => {
  it('answers a 2025-era request with a JSON body, not an event stream', async () => {
    const response = await legacyPost(t.endpoint, t.tokens.Omar ?? '', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as {
      id: number
      result: { tools: Array<{ name: string }> }
    }
    expect(body.id).toBe(7)
    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['send', 'inbox', 'wait_for_reply', 'open_debate', 'submit_report']),
    )
  })
})
