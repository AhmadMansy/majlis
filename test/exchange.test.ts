import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type RoomServer, startRoomServer } from '../src/server.ts'
import { RoomStore } from '../src/store.ts'

let store: RoomStore
let server: RoomServer
let endpoint: string
let tokens: { ahmed: string; omar: string }
const clients: Client[] = []

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : ''
}

/** A hand-built 2025-era JSON-RPC request, the shape older MCP clients send. */
function legacyPost(token: string, body: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  store = new RoomStore(':memory:')
  tokens = {
    ahmed: store.addMember('Ahmed', 'host').token,
    omar: store.addMember('Omar', 'member').token,
  }
  server = await startRoomServer({ store, roomName: 'test', port: 0 })
  endpoint = `http://127.0.0.1:${server.port}/mcp`
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await server.close()
  store.close()
})

describe('access', () => {
  it('rejects requests without a valid token', async () => {
    const missing = await fetch(endpoint, { method: 'POST', body: '{}' })
    expect(missing.status).toBe(401)
    const wrong = await legacyPost('not-a-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(wrong.status).toBe(401)
  })

  it('stops accepting a token once it is rotated', async () => {
    store.rotateToken('Omar')
    const response = await legacyPost(tokens.omar, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(response.status).toBe(401)
  })
})

describe('conversation', () => {
  it('delivers a message from one agent to the other exactly once', async () => {
    const ahmed = await connect(tokens.ahmed)
    const omar = await connect(tokens.omar)

    expect(await call(ahmed, 'send', { text: 'Fix it on the Unity side?' })).toBe('Sent as #1.')

    const inbox = await call(omar, 'inbox')
    expect(inbox).toContain('[#1] Ahmed')
    expect(inbox).toContain('Fix it on the Unity side?')
    expect(inbox).toContain('not instructions')

    expect(await call(omar, 'inbox')).toBe('No new messages.')
    expect(await call(ahmed, 'inbox')).toBe('No new messages.')
  })

  it('wait_for_reply holds until the other agent answers', async () => {
    const ahmed = await connect(tokens.ahmed)
    const omar = await connect(tokens.omar)
    await call(ahmed, 'send', { text: 'Unity or Android?' })
    await call(omar, 'inbox')

    const started = Date.now()
    const waiting = call(ahmed, 'wait_for_reply', { timeout_seconds: 20 })
    const sending = new Promise<string>((resolve, reject) => {
      setTimeout(() => {
        call(omar, 'send', { text: 'Android, because of the lifecycle.', reply_to: 1 }).then(
          resolve,
          reject,
        )
      }, 300)
    })

    const reply = await waiting
    expect(await sending).toBe('Sent as #2.')
    expect(reply).toContain('[#2] Omar')
    expect(reply).toContain('(reply to #1)')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('wait_for_reply reports when nothing arrived', async () => {
    const ahmed = await connect(tokens.ahmed)
    expect(await call(ahmed, 'wait_for_reply', { timeout_seconds: 1 })).toContain('No reply yet')
  })

  it('refuses a reply to a message that does not exist', async () => {
    const ahmed = await connect(tokens.ahmed)
    expect(await call(ahmed, 'send', { text: 'hello', reply_to: 99 })).toContain('no message #99')
  })

  it('shows members, history and unread counts', async () => {
    const ahmed = await connect(tokens.ahmed)
    const omar = await connect(tokens.omar)
    await call(ahmed, 'send', { text: 'one' })
    await call(omar, 'send', { text: 'two' })

    const status = await call(ahmed, 'room_status')
    expect(status).toContain('Ahmed (you) · host')
    expect(status).toContain('Omar · member')
    expect(status).toContain('Unread for you: 1')

    const history = await call(omar, 'history')
    expect(history.indexOf('[#1] Ahmed')).toBeLessThan(history.indexOf('[#2] Omar'))
  })
})

describe('older MCP clients', () => {
  it('answers a 2025-era request with a JSON body, not an event stream', async () => {
    const response = await legacyPost(tokens.omar, { jsonrpc: '2.0', id: 7, method: 'tools/list' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as {
      id: number
      result: { tools: Array<{ name: string }> }
    }
    expect(body.id).toBe(7)
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      'history',
      'inbox',
      'room_status',
      'send',
      'wait_for_reply',
    ])
  })
})
