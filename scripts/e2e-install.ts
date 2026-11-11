/**
 * End-to-end check of the packaged app, the way two new users meet it:
 * install release/majlis.tgz into an empty folder, host a room on a machine
 * that has never run Majlis (so cloudflared is downloaded), join it from a
 * second "machine" through the public address, and let the two agents work.
 * Run `pnpm release:pack` first. Needs network access.
 */
import { type ChildProcess, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const root = join(import.meta.dirname, '..')
const tarball = join(root, 'release', 'majlis.tgz')
if (!existsSync(tarball)) throw new Error('Run `pnpm release:pack` first.')

const work = mkdtempSync(join(tmpdir(), 'majlis-e2e-'))
const prefix = join(work, 'prefix')
const children: ChildProcess[] = []

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  - ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const env = (home: string): NodeJS.ProcessEnv => {
  // The machine's own cloudflared must not be found: a new user has none.
  const { MAJLIS_CLOUDFLARED: _unused, ...rest } = process.env
  return { ...rest, MAJLIS_HOME: join(work, home) }
}

/** Starts a long-running majlis command and resolves with its output once it is ready. */
function start(cli: string, home: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: env(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`majlis ${args[0]} was not ready in time:\n${output}`)),
      timeoutMs,
    )
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.includes('Press Ctrl+C')) {
        clearTimeout(timer)
        resolve(output)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`majlis ${args[0]} exited with code ${code}:\n${output}`))
    })
  })
}

function run(cli: string, home: string, args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    env: env(home),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** Runs a command that is expected to be refused, and returns what it printed. */
function refused(cli: string, home: string, args: string[]): string {
  const result = spawnSync(process.execPath, [cli, ...args], { env: env(home), encoding: 'utf8' })
  if (result.status === 0) throw new Error(`majlis ${args[0]} was expected to be refused.`)
  return `${result.stdout}${result.stderr}`.trim()
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  // On Windows the tunnel is a grandchild, which a plain kill would leave running.
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      // Already gone.
    }
  } else child.kill('SIGINT')
}

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

async function until(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

const port = () => 20_000 + Math.floor(Math.random() * 20_000)

try {
  execSync(`npm install -g --prefix "${prefix}" "${tarball}"`, { stdio: 'ignore' })
  const cli = [
    join(prefix, 'node_modules', 'majlis-room', 'dist', 'cli.js'),
    join(prefix, 'lib', 'node_modules', 'majlis-room', 'dist', 'cli.js'),
  ].find((path) => existsSync(path))
  if (!cli) throw new Error('The installed package has no dist/cli.js.')
  const version = (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  ).version
  check(
    'installs from the release file and reports its version',
    run(cli, 'a', ['--version']) === version,
  )
  check(
    'a hook stays silent on a machine with no room',
    run(cli, 'a', ['unread', '--hook', 'SessionStart']) === '',
  )

  // ── The host: a machine that has never run Majlis ──────────────────
  const hostPort = port()
  const hostOut = await start(
    cli,
    'a',
    [
      'host',
      '--name',
      'Ahmed',
      '--invite',
      'Omar',
      '--approval',
      'auto',
      '--port',
      String(hostPort),
    ],
    240_000,
  )
  check('downloads cloudflared by itself on first use', hostOut.includes('Downloading cloudflared'))
  const publicUrl = /Public address: (https:\/\/\S+)\/mcp/.exec(hostOut)?.[1]
  check('opens a public address', Boolean(publicUrl), publicUrl ?? hostOut.slice(-400))
  const ahmedToken = /== Ahmed ==[\s\S]*?Bearer ([\w-]+)"/.exec(hostOut)?.[1]
  const omarJoin = /majlis join (https:\/\/\S+) --token ([\w-]+)/.exec(hostOut)
  check('prints a join command for the invited member', Boolean(omarJoin))
  if (!publicUrl || !ahmedToken || !omarJoin?.[1] || !omarJoin[2])
    throw new Error('Cannot continue.')

  // Starting the same room a second time must stop before it opens or changes anything.
  const second = refused(cli, 'a', ['host', '--invite', 'Zed', '--port', String(port())])
  check(
    'a second start of a running room is refused before anything is opened',
    second.includes('already running on this machine') &&
      second.includes('majlis stop') &&
      !second.includes('Cloudflare'),
    second.split('\n')[0],
  )

  // ── The member: a second machine, keeping a copy ───────────────────
  const copyPort = port()
  const copyOut = await start(
    cli,
    'b',
    ['join', omarJoin[1], '--token', omarJoin[2], '--approval', 'auto', '--port', String(copyPort)],
    90_000,
  )
  const omarToken = /Bearer ([\w-]+)"/.exec(copyOut)?.[1]
  check('joins through the public address and gets a local token', Boolean(omarToken))
  if (!omarToken) throw new Error('Cannot continue.')

  const ahmed = await connect(`http://127.0.0.1:${hostPort}/mcp`, ahmedToken)
  const omar = await connect(`http://127.0.0.1:${copyPort}/mcp`, omarToken)

  await call(ahmed, 'set_profile', { profile: 'Unity side. Owns the RecitationBridge plugin.' })
  await call(ahmed, 'pin_contract', { name: 'bridge api', content: 'void Pause(); void Resume();' })
  await call(ahmed, 'send', { text: 'Should the fix live on the Unity side or the Android side?' })

  const synced = await until(async () =>
    (await call(omar, 'contracts', { name: 'bridge api' })).includes('void Pause();'),
  )
  check("the pinned contract reaches the member's copy", synced)
  check(
    "the member's agent sees what the host's side owns",
    (await call(omar, 'room_status')).includes('Owns the RecitationBridge plugin.'),
  )

  const notice = run(cli, 'b', ['unread', '--hook', 'UserPromptSubmit'])
  check(
    'the hook tells the member about unread posts, without their content',
    notice.includes('unread posts in the shared room from Ahmed') &&
      !notice.includes('Unity side or'),
    notice,
  )
  check(
    'the hook says it only once',
    run(cli, 'b', ['unread', '--hook', 'UserPromptSubmit']) === '',
  )

  check(
    "the member's agent reads the message from its copy",
    (await call(omar, 'inbox')).includes('Unity side or the Android side'),
  )
  await call(omar, 'send', { text: 'Android side: onResume loses the state.' })
  const reply = await call(ahmed, 'wait_for_reply', { timeout_seconds: 30 })
  check("the host's agent receives the member's answer", reply.includes('onResume loses the state'))

  check('the refused start added no member', !(await call(ahmed, 'room_status')).includes('Zed'))

  await Promise.all([ahmed.close(), omar.close()])

  // ── Stopping a room whose window is gone ───────────────────────────
  check('stop ends the running room', run(cli, 'a', ['stop']).includes('Stopped room "default"'))
  const gone = await until(async () => {
    try {
      await fetch(`http://127.0.0.1:${hostPort}/health`, { signal: AbortSignal.timeout(1500) })
      return false
    } catch {
      return true
    }
  }, 10_000)
  check('the stopped room no longer answers', gone)
  check('stop says so when nothing is running', run(cli, 'a', ['stop']).includes('is not running'))
} finally {
  for (const child of children) stop(child)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
