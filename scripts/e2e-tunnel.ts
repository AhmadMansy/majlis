/**
 * End-to-end check over a real Cloudflare quick tunnel: a host agent on
 * loopback and a remote agent on the public address hold one exchange.
 * Run with `pnpm e2e:tunnel`. Needs network access and cloudflared.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Room } from '../src/room.ts'
import { startRoomServer } from '../src/server.ts'
import { RoomStore } from '../src/store.ts'
import { startQuickTunnel, waitUntilReachable } from '../src/tunnel.ts'

const HOLD_SECONDS = Number(process.env.HOLD_SECONDS ?? 20)

async function connect(endpoint: string, token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-agent', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
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

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const store = new RoomStore(':memory:')
const hostToken = store.addMember('Host', 'host').token
const remoteToken = store.addMember('Remote', 'member').token
const server = await startRoomServer({ room: new Room(store, 'e2e'), port: 0 })
const tunnel = await startQuickTunnel(server.port)

try {
  console.log(`tunnel: ${tunnel.url}`)
  check('tunnel answers /health', await waitUntilReachable(tunnel.url))

  const denied = await fetch(`${tunnel.url}/mcp`, { method: 'POST', body: '{}' })
  check(
    'public address rejects a request with no token',
    denied.status === 401,
    `status ${denied.status}`,
  )

  const legacy = await fetch(`${tunnel.url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${remoteToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  check(
    'older-client request through the tunnel returns JSON',
    legacy.status === 200 &&
      (legacy.headers.get('content-type') ?? '').includes('application/json'),
    `status ${legacy.status}, ${legacy.headers.get('content-type')}`,
  )

  const host = await connect(`http://127.0.0.1:${server.port}/mcp`, hostToken)
  const remote = await connect(`${tunnel.url}/mcp`, remoteToken)

  await call(host, 'send', { text: 'Should the fix live on the Unity side or the Android side?' })
  const inbox = await call(remote, 'inbox')
  check('remote agent reads the host message through the tunnel', inbox.includes('[#1] Host'))

  // The remote agent holds a long request open through the tunnel while the host "thinks".
  const started = Date.now()
  const waiting = call(remote, 'wait_for_reply', {
    timeout_seconds: Math.min(50, HOLD_SECONDS + 15),
  })
  await new Promise((resolve) => setTimeout(resolve, HOLD_SECONDS * 1000))
  await call(host, 'send', {
    text: 'Android side: the lifecycle callback is where the state is lost.',
  })
  const reply = await waiting
  const held = ((Date.now() - started) / 1000).toFixed(1)
  check(
    `remote agent's wait survives ${HOLD_SECONDS}s through the tunnel and gets the reply`,
    reply.includes('[#2] Host'),
    `returned after ${held}s`,
  )

  await call(remote, 'send', { text: 'Agreed. I will patch onResume.', reply_to: 2 })
  const answer = await call(host, 'wait_for_reply', { timeout_seconds: 5 })
  check(
    'host agent receives the remote answer',
    answer.includes('[#3] Remote') && answer.includes('(reply to #2)'),
  )

  await Promise.all([host.close(), remote.close()])
} finally {
  tunnel.stop()
  await server.close()
  store.close()
}
