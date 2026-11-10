#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { startRoomServer } from './server.ts'
import { RoomStore } from './store.ts'
import { startQuickTunnel, type Tunnel, waitUntilReachable } from './tunnel.ts'

interface RoomState {
  room: string
  port: number
  url: string | null
  pid: number
}

const USAGE = `majlis - a shared room where coding agents talk

  majlis host   [--room <name>] [--name <you>] [--port 8787] [--no-tunnel] [--invite <name>]...
  majlis invite <name> [--room <name>] [--rotate]

host    Start the room on this machine and open a Cloudflare quick tunnel to it.
invite  Create a token for someone (or --rotate an existing member's token) and print how to connect.
`

const dataDir = (room: string): string =>
  process.env.MAJLIS_HOME ? join(process.env.MAJLIS_HOME, room) : join(homedir(), '.majlis', room)

function connectHelp(name: string, url: string, token: string): string {
  const endpoint = `${url}/mcp`
  const config = JSON.stringify(
    {
      mcpServers: {
        majlis: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  )
  return [
    `== ${name} ==`,
    'Claude Code:',
    `  claude mcp add --transport http majlis ${endpoint} --header "Authorization: Bearer ${token}"`,
    'Other MCP clients (config file):',
    config
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    '',
  ].join('\n')
}

async function host(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      room: { type: 'string', default: 'default' },
      name: { type: 'string', default: userInfo().username },
      port: { type: 'string', default: '8787' },
      'no-tunnel': { type: 'boolean', default: false },
      invite: { type: 'string', multiple: true, default: [] },
    },
  })
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`Invalid port: ${values.port}`)

  const dir = dataDir(values.room)
  mkdirSync(dir, { recursive: true })
  const store = new RoomStore(join(dir, 'room.db'))
  const statePath = join(dir, 'state.json')

  const issued: Array<{ name: string; token: string; local: boolean }> = []
  if (!store.memberByName(values.name)) {
    issued.push({
      name: values.name,
      token: store.addMember(values.name, 'host').token,
      local: true,
    })
  }
  for (const name of values.invite) {
    if (store.memberByName(name)) {
      console.log(
        `"${name}" is already a member; use \`majlis invite ${name} --rotate\` for a new token.`,
      )
    } else {
      issued.push({ name, token: store.addMember(name, 'member').token, local: false })
    }
  }

  const server = await startRoomServer({ store, roomName: values.room, port })
  const localUrl = `http://127.0.0.1:${server.port}`
  console.log(`Room "${values.room}" is open at ${localUrl}/mcp  (data: ${dir})`)

  let tunnel: Tunnel | undefined
  if (!values['no-tunnel']) {
    console.log('Opening Cloudflare quick tunnel...')
    tunnel = await startQuickTunnel(server.port)
    const reachable = await waitUntilReachable(tunnel.url)
    console.log(
      reachable
        ? `Public address: ${tunnel.url}/mcp`
        : `Tunnel address ${tunnel.url} did not answer yet; it may need a little longer.`,
    )
    console.log('This address changes every time the host restarts; remote members must re-add it.')
  }

  const state: RoomState = {
    room: values.room,
    port: server.port,
    url: tunnel?.url ?? null,
    pid: process.pid,
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2))

  if (issued.length > 0) {
    console.log('\nTokens are shown once. Send each person only their own block.\n')
    for (const { name, token, local } of issued) {
      console.log(connectHelp(name, local ? localUrl : (tunnel?.url ?? localUrl), token))
    }
  }
  console.log('Press Ctrl+C to close the room.')

  const shutdown = async () => {
    console.log('\nClosing room...')
    tunnel?.stop()
    rmSync(statePath, { force: true })
    await server.close()
    store.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

function invite(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      room: { type: 'string', default: 'default' },
      rotate: { type: 'boolean', default: false },
    },
  })
  const name = positionals[0]
  if (!name) throw new Error('Usage: majlis invite <name> [--room <name>] [--rotate]')

  const dir = dataDir(values.room)
  const statePath = join(dir, 'state.json')
  if (!existsSync(statePath)) {
    throw new Error(`Room "${values.room}" is not running. Start it with \`majlis host\` first.`)
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as RoomState
  const store = new RoomStore(join(dir, 'room.db'))
  try {
    const existing = store.memberByName(name)
    let token: string | undefined
    if (existing && !values.rotate) {
      throw new Error(`"${name}" is already a member. Add --rotate to replace their token.`)
    }
    if (existing) token = store.rotateToken(name)
    else token = store.addMember(name, 'member').token
    if (!token) throw new Error(`Could not issue a token for "${name}".`)

    const local = existing?.role === 'host'
    const url = local
      ? `http://127.0.0.1:${state.port}`
      : (state.url ?? `http://127.0.0.1:${state.port}`)
    if (!local && !state.url)
      console.log('The room has no tunnel; this address only works on the host machine.\n')
    console.log(connectHelp(name, url, token))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'host') await host(rest)
  else if (command === 'invite') invite(rest)
  else console.log(USAGE)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
