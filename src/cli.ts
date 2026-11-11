#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { startAdminServer } from './admin.ts'
import { connectHelp } from './connect.ts'
import { copyOutbound, hostOutbound } from './outbound.ts'
import { Room } from './room.ts'
import { startRoomServer } from './server.ts'
import { type ApprovalMode, RoomStore } from './store.ts'
import { joinRoom, normalizeHostUrl, probe, SyncClient } from './sync.ts'
import { startQuickTunnel, type Tunnel, waitUntilReachable } from './tunnel.ts'

interface RunState {
  room: string
  kind: 'host' | 'mirror'
  port: number
  url: string | null
  pid: number
}

const USAGE = `majlis - a shared room where coding agents talk

  majlis host    [--room <name>] [--name <you>] [--port 8787] [--panel-port <n>] [--no-tunnel]
                 [--approval every|debate|auto] [--invite <name>]...
  majlis join    <room address> --token <token> [--room <local name>] [--port 8787]
                 [--panel-port <n>] [--approval every|debate|auto] [--new-token]
  majlis join    --room <local name>            (start an existing copy again)
  majlis invite  <name> [--room <name>] [--rotate]
  majlis promote [--room <local name>]

host     Start a room on this machine, open a Cloudflare quick tunnel to it, and serve the
         control panel on a second local port (default: the room port + 1).
join     Keep a copy of someone else's room on this machine. Your agent talks to the copy,
         which works while the host is offline and sends your posts when it is back.
invite   Create a token for someone (or --rotate an existing member's token).
promote  Turn your copy into the room itself, when the original host is gone for good.

--approval  When your own agent's posts need your approval in the panel before they leave
            this machine: every post (default), once per debate, or never (auto).
`

const APPROVAL: Record<ApprovalMode, string> = {
  every:
    'Approval: you approve every post by your agent in the panel (change it there or with --approval).',
  debate: 'Approval: you approve once per debate, and every free message.',
  auto: 'Approval: off. Your agent posts without asking you.',
}

const home = (): string => process.env.MAJLIS_HOME ?? join(homedir(), '.majlis')

function dataDir(room: string): string {
  if (!/^[\w.-]{1,60}$/.test(room) || room === 'bin') {
    throw new Error(`"${room}" cannot be used as a room name here: use letters, digits, - and _.`)
  }
  return join(home(), room)
}

function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return parsed
}

function approval(value: string | undefined): ApprovalMode | undefined {
  if (value === undefined) return undefined
  if (value === 'every' || value === 'debate' || value === 'auto') return value
  throw new Error('--approval must be one of: every, debate, auto.')
}

/** The process currently serving a room folder, if its state file names one that is still alive. */
function running(dir: string): RunState | undefined {
  const path = join(dir, 'state.json')
  if (!existsSync(path)) return undefined
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
    process.kill(state.pid, 0)
    return state
  } catch {
    // Unreadable, or the process is gone: the state file is stale.
    return undefined
  }
}

/** Refuses to start a second process on a room folder that another one is already serving. */
function claim(dir: string, state: RunState): string {
  const previous = running(dir)
  if (previous && previous.pid !== process.pid) {
    throw new Error(`Room "${state.room}" is already running here (process ${previous.pid}).`)
  }
  const path = join(dir, 'state.json')
  writeFileSync(path, JSON.stringify(state, null, 2))
  return path
}

function explainListen(error: unknown, which: string, wanted: number): never {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    throw new Error(`Port ${wanted} is already in use. Choose another with ${which}.`)
  }
  throw error
}

async function host(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      room: { type: 'string', default: 'default' },
      name: { type: 'string', default: userInfo().username },
      port: { type: 'string' },
      'panel-port': { type: 'string' },
      'no-tunnel': { type: 'boolean', default: false },
      approval: { type: 'string' },
      invite: { type: 'string', multiple: true, default: [] },
    },
  })
  const roomPort = port(values.port, 8787)
  const mode = approval(values.approval)

  const dir = dataDir(values.room)
  mkdirSync(dir, { recursive: true })
  const store = new RoomStore(join(dir, 'room.db'))
  if (store.kind() === 'mirror') {
    throw new Error(
      `"${values.room}" on this machine is a copy of someone else's room. Start it with \`majlis join --room ${values.room}\`, ` +
        `or run \`majlis promote --room ${values.room}\` first if the original host is gone.`,
    )
  }
  store.setKind('host')
  if (mode) store.updateLocalSettings({ approval: mode })

  const issued: Array<{ name: string; token: string; local: boolean }> = []
  if (!store.hostMember()) {
    if (store.nameTaken(values.name)) throw new Error(`The name "${values.name}" is already used.`)
    issued.push({
      name: values.name,
      token: store.addMember(values.name, 'host').token,
      local: true,
    })
  }
  for (const name of values.invite) {
    if (store.nameTaken(name)) {
      console.log(
        `"${name}" is already a member; use \`majlis invite ${name} --rotate\` for a new token.`,
      )
    } else {
      issued.push({ name, token: store.addMember(name, 'member').token, local: false })
    }
  }

  const room = new Room(store, values.room)
  const outbound = hostOutbound(room)
  const server = await startRoomServer({
    room,
    port: roomPort,
    outbound,
    serveCopies: true,
  }).catch((error: unknown) => explainListen(error, '--port', roomPort))
  const localUrl = `http://127.0.0.1:${server.port}`
  console.log(`Room "${values.room}" is open at ${localUrl}/mcp  (data: ${dir})`)

  let tunnel: Tunnel | undefined
  if (!values['no-tunnel']) {
    console.log('Opening Cloudflare quick tunnel...')
    tunnel = await startQuickTunnel(server.port)
    room.urls.public = tunnel.url
    const reachable = await waitUntilReachable(tunnel.url)
    console.log(
      reachable
        ? `Public address: ${tunnel.url}/mcp`
        : `Tunnel address ${tunnel.url} did not answer yet; it may need a little longer.`,
    )
    console.log(
      'This address changes every time the host restarts; members must be given the new one.',
    )
  }

  const statePath = claim(dir, {
    room: values.room,
    kind: 'host',
    port: server.port,
    url: tunnel?.url ?? null,
    pid: process.pid,
  })

  if (issued.length > 0) {
    console.log('\nTokens are shown once. Send each person only their own block.\n')
    for (const { name, token, local } of issued) {
      console.log(connectHelp(name, local ? localUrl : (tunnel?.url ?? localUrl), token, !local))
    }
  }
  const panelPort = port(values['panel-port'], server.port + 1)
  const admin = await startAdminServer({ room, port: panelPort, outbound }).catch(
    (error: unknown) => explainListen(error, '--panel-port', panelPort),
  )
  console.log(APPROVAL[store.localSettings().approval])
  console.log(`Control panel (this machine only, do not share this link):\n  ${admin.url}\n`)
  console.log('Press Ctrl+C to close the room.')

  const shutdown = async () => {
    console.log('\nClosing room...')
    tunnel?.stop()
    rmSync(statePath, { force: true })
    await admin.close()
    await server.close()
    store.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

async function joinCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      token: { type: 'string' },
      room: { type: 'string' },
      port: { type: 'string' },
      'panel-port': { type: 'string' },
      approval: { type: 'string' },
      'new-token': { type: 'boolean', default: false },
    },
  })
  const address = positionals[0]
  const copyPort = port(values.port, 8787)
  const mode = approval(values.approval)

  // The local folder is named after the room unless the user chose a name.
  let local = values.room
  if (!local) {
    if (!address || !values.token) {
      throw new Error(
        'Give the room address and --token, or --room <name> to start an existing copy.',
      )
    }
    local = (await probe(normalizeHostUrl(address), values.token)).room
  }
  const dir = dataDir(local)
  mkdirSync(dir, { recursive: true })
  const store = new RoomStore(join(dir, 'room.db'))

  const known = store.mirrorConfig()
  if (address) {
    const token = values.token ?? known?.token
    if (!token) throw new Error('This is a new copy: give --token as well.')
    try {
      await joinRoom(store, address, token)
    } catch (error) {
      // An existing copy may start with a new address even while that host is unreachable.
      if (!known || store.kind() !== 'mirror') throw error
      store.setMirrorConfig({ ...known, hostUrl: normalizeHostUrl(address), token })
      console.log(`Could not reach the room yet: ${error instanceof Error ? error.message : error}`)
    }
  } else if (!known) {
    throw new Error(`There is no copy named "${local}" here. Give the room address and --token.`)
  }

  const config = store.mirrorConfig()
  const me = config ? store.memberById(config.meId) : undefined
  if (!config || !me)
    throw new Error('This copy has no member; join again with the address and token.')
  if (mode) store.updateLocalSettings({ approval: mode })

  const room = new Room(store, config.room)
  const outbound = copyOutbound(store)
  const sync = new SyncClient(store, () => outbound.flush())
  const server = await startRoomServer({ room, port: copyPort, outbound }).catch((error: unknown) =>
    explainListen(error, '--port', copyPort),
  )
  const localUrl = `http://127.0.0.1:${server.port}`
  const statePath = claim(dir, {
    room: local,
    kind: 'mirror',
    port: server.port,
    url: null,
    pid: process.pid,
  })
  console.log(`Your copy of room "${config.room}" is at ${localUrl}/mcp  (data: ${dir})`)
  console.log(`You are ${me.name} (${me.role}). The room itself is at ${config.hostUrl}`)

  if (values['new-token'] || !store.hasLocalToken(me.id)) {
    console.log(
      '\nConnect your own agent to your copy. This token is shown once and never leaves this machine.\n',
    )
    console.log(connectHelp(me.name, localUrl, store.issueLocalToken(me.id)))
  }

  const panelPort = port(values['panel-port'], server.port + 1)
  const admin = await startAdminServer({ room, port: panelPort, outbound, sync }).catch(
    (error: unknown) => explainListen(error, '--panel-port', panelPort),
  )
  sync.start()
  console.log(APPROVAL[store.localSettings().approval])
  console.log(`Your panel (this machine only, do not share this link):\n  ${admin.url}\n`)
  console.log('Press Ctrl+C to stop. Your copy stays on this machine.')

  const shutdown = async () => {
    console.log('\nStopping...')
    sync.stop()
    rmSync(statePath, { force: true })
    await admin.close()
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
  const state = running(dir)
  if (!state) {
    throw new Error(`Room "${values.room}" is not running. Start it with \`majlis host\` first.`)
  }
  if (state.kind === 'mirror') throw new Error('Only the host of a room can invite people.')
  const store = new RoomStore(join(dir, 'room.db'))
  try {
    const existing = store.memberByName(name)
    let token: string | undefined
    if (!existing && store.nameTaken(name)) {
      throw new Error(`"${name}" was removed from this room; invite them under another name.`)
    }
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
    console.log(connectHelp(name, url, token, !local))
  } finally {
    store.close()
  }
}

function promote(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { room: { type: 'string', default: 'default' } },
  })
  const dir = dataDir(values.room)
  if (!existsSync(join(dir, 'room.db')))
    throw new Error(`There is no copy named "${values.room}" here.`)
  if (running(dir)) {
    throw new Error('Stop the running copy first (Ctrl+C in its window), then promote it.')
  }
  const store = new RoomStore(join(dir, 'room.db'))
  try {
    const config = store.mirrorConfig()
    if (store.kind() !== 'mirror' || !config) {
      throw new Error(`"${values.room}" is not a copy of someone else's room.`)
    }
    const me = store.memberById(config.meId)
    if (!me) throw new Error('This copy has no member to become the host.')
    store.promoteCopy(me.id)
    console.log(
      [
        `Your copy of "${config.room}" is now the room, with ${store.eventCount()} messages, and you (${me.name}) are its host.`,
        '',
        'Next:',
        `  1. Start it:  majlis host --room ${values.room}`,
        '  2. In the panel, give every member a "New token" and send it to them with the new address.',
        '',
        'Anything posted to the old room after your copy last synced is not in this one.',
      ].join('\n'),
    )
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'host') await host(rest)
  else if (command === 'join') await joinCommand(rest)
  else if (command === 'invite') invite(rest)
  else if (command === 'promote') promote(rest)
  else console.log(USAGE)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
