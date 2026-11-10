import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Room } from '../src/room.ts'
import { type RoomServer, startRoomServer } from '../src/server.ts'
import { RoomStore } from '../src/store.ts'

export interface TestRoom {
  store: RoomStore
  room: Room
  server: RoomServer
  endpoint: string
  tokens: Record<string, string>
  /** Connects an MCP client as the named member. */
  agent: (name: string) => Promise<Agent>
  close: () => Promise<void>
}

export interface Agent {
  client: Client
  /** Calls a tool and returns its text; `failed` tells whether the tool reported an error. */
  call: (tool: string, args?: Record<string, unknown>) => Promise<string>
  fails: (tool: string, args?: Record<string, unknown>) => Promise<string>
}

/** A room with a host named Ahmed and the given extra members, served on a random loopback port. */
export async function openTestRoom(members: string[] = ['Omar']): Promise<TestRoom> {
  const store = new RoomStore(':memory:')
  const tokens: Record<string, string> = { Ahmed: store.addMember('Ahmed', 'host').token }
  for (const name of members) tokens[name] = store.addMember(name, 'member').token
  const room = new Room(store, 'test')
  const server = await startRoomServer({ room, port: 0 })
  const endpoint = `http://127.0.0.1:${server.port}/mcp`
  const clients: Client[] = []

  const agent = async (name: string): Promise<Agent> => {
    const client = new Client({ name: `${name}-agent`, version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${tokens[name]}` } },
      }),
    )
    clients.push(client)
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
    }
  }

  return {
    store,
    room,
    server,
    endpoint,
    tokens,
    agent,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()))
      await server.close()
      store.close()
    },
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
