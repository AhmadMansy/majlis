import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { copyOutbound, hostOutbound, type Outbound } from '../src/outbound.ts'
import { Room } from '../src/room.ts'
import { type RoomServer, startRoomServer } from '../src/server.ts'
import { RoomStore } from '../src/store.ts'
import { joinRoom, SyncClient } from '../src/sync.ts'

export interface Agent {
  client: Client
  /** Calls a tool and returns its text; throws if the tool reported an error. */
  call: (tool: string, args?: Record<string, unknown>) => Promise<string>
  /** Calls a tool that is expected to report an error, and returns the error text. */
  fails: (tool: string, args?: Record<string, unknown>) => Promise<string>
  close: () => Promise<void>
}

/** Connects an MCP client to a room or copy endpoint with the given token. */
export async function connectAgent(endpoint: string, token: string): Promise<Agent> {
  const client = new Client({ name: 'test-agent', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  const run = async (tool: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: tool, arguments: args })
    const first = result.content[0]
    return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true }
  }
  return {
    client,
    call: async (tool, args = {}) => {
      const result = await run(tool, args)
      if (result.isError) throw new Error(`${tool} failed: ${result.text}`)
      return result.text
    },
    fails: async (tool, args = {}) => {
      const result = await run(tool, args)
      if (!result.isError)
        throw new Error(`${tool} was expected to fail but returned: ${result.text}`)
      return result.text
    },
    close: () => client.close(),
  }
}

export interface TestRoom {
  store: RoomStore
  room: Room
  outbound: Outbound
  server: RoomServer
  /** The room's base address, without /mcp. */
  url: string
  endpoint: string
  tokens: Record<string, string>
  /** Connects an MCP client as the named member, straight to the host. */
  agent: (name: string) => Promise<Agent>
  /** Stops only the HTTP server, as if the host machine went away. */
  stopServer: () => Promise<void>
  /** Starts the HTTP server again on the same port. */
  restartServer: () => Promise<void>
  close: () => Promise<void>
}

/**
 * A room with a host named Ahmed and the given extra members, served on a
 * random loopback port. The host's own agent posts without approval unless a
 * test changes that.
 */
export async function openTestRoom(members: string[] = ['Omar']): Promise<TestRoom> {
  const store = new RoomStore(':memory:')
  store.setKind('host')
  store.updateLocalSettings({ approval: 'auto' })
  const tokens: Record<string, string> = { Ahmed: store.addMember('Ahmed', 'host').token }
  for (const name of members) tokens[name] = store.addMember(name, 'member').token
  const room = new Room(store, 'test')
  const outbound = hostOutbound(room)
  let server = await startRoomServer({ room, port: 0, outbound, serveCopies: true })
  const port = server.port
  const url = `http://127.0.0.1:${port}`
  const agents: Agent[] = []
  let serving = true

  const test: TestRoom = {
    store,
    room,
    outbound,
    server,
    url,
    endpoint: `${url}/mcp`,
    tokens,
    agent: async (name) => {
      const agent = await connectAgent(`${url}/mcp`, tokens[name] ?? '')
      agents.push(agent)
      return agent
    },
    stopServer: async () => {
      if (serving) await server.close()
      serving = false
    },
    restartServer: async () => {
      server = await startRoomServer({ room, port, outbound, serveCopies: true })
      test.server = server
      serving = true
    },
    close: async () => {
      await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)))
      if (serving) await server.close()
      store.close()
    },
  }
  return test
}

export interface TestCopy {
  store: RoomStore
  room: Room
  outbound: Outbound
  sync: SyncClient
  server: RoomServer
  /** The copy owner's own agent, connected to the copy. */
  agent: Agent
  close: () => Promise<void>
}

/** A member's copy of a test room, synced once, with that member's agent connected to it. */
export async function openTestCopy(host: TestRoom, name: string): Promise<TestCopy> {
  const store = new RoomStore(':memory:')
  store.updateLocalSettings({ approval: 'auto' })
  const { me } = await joinRoom(store, host.url, host.tokens[name] ?? '')
  const room = new Room(store, 'test')
  const outbound = copyOutbound(store)
  const sync = new SyncClient(store, () => outbound.flush())
  await sync.syncOnce()
  const server = await startRoomServer({ room, port: 0, outbound })
  const agent = await connectAgent(
    `http://127.0.0.1:${server.port}/mcp`,
    store.issueLocalToken(me.id),
  )
  return {
    store,
    room,
    outbound,
    sync,
    server,
    agent,
    close: async () => {
      sync.stop()
      await agent.close().catch(() => undefined)
      await server.close()
      store.close()
    },
  }
}

/** Polls until the condition holds, for effects that arrive through the background sync. */
export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A hand-built 2025-era JSON-RPC request, the shape older MCP clients send. */
export function legacyPost(endpoint: string, token: string, body: unknown): Promise<Response> {
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
