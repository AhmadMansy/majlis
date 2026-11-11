import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download'

export interface Tunnel {
  url: string
  stop: () => void
}

const binDir = (): string => join(process.env.MAJLIS_HOME ?? join(homedir(), '.majlis'), 'bin')
const ownBinary = (): string =>
  join(binDir(), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')

/** Candidate cloudflared binaries, most specific first; the bare name relies on PATH. */
export function cloudflaredCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.MAJLIS_CLOUDFLARED) candidates.push(process.env.MAJLIS_CLOUDFLARED)
  candidates.push(ownBinary())
  if (process.platform === 'win32') {
    for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      if (root) candidates.push(join(root, 'cloudflared', 'cloudflared.exe'))
    }
  }
  return [...candidates.filter((path) => existsSync(path)), 'cloudflared']
}

/** Whether some cloudflared can be started on this machine. */
export function hasCloudflared(): boolean {
  return cloudflaredCandidates().some((bin) => {
    if (bin !== 'cloudflared') return true
    return spawnSync(bin, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0
  })
}

/** The release file Cloudflare publishes for this machine, or undefined when there is none. */
function releaseAsset(): { file: string; archive: boolean } | undefined {
  const arm = process.arch === 'arm64'
  if (process.platform === 'win32') return { file: 'cloudflared-windows-amd64.exe', archive: false }
  if (process.platform === 'linux') {
    if (process.arch !== 'x64' && !arm) return undefined
    return { file: `cloudflared-linux-${arm ? 'arm64' : 'amd64'}`, archive: false }
  }
  if (process.platform === 'darwin') {
    return { file: `cloudflared-darwin-${arm ? 'arm64' : 'amd64'}.tgz`, archive: true }
  }
  return undefined
}

/**
 * Downloads cloudflared from Cloudflare's own GitHub releases into the Majlis
 * folder, for people who do not have it. Nothing is installed system-wide.
 */
export async function downloadCloudflared(
  log: (line: string) => void = console.log,
): Promise<string> {
  const asset = releaseAsset()
  if (!asset) {
    throw new Error(
      `There is no cloudflared download for ${process.platform}/${process.arch}. Install it yourself, ` +
        'set MAJLIS_CLOUDFLARED to its path, or run with --no-tunnel.',
    )
  }
  const url = `${RELEASES}/${asset.file}`
  log(`Downloading cloudflared from ${url} (one time, about 50 MB)...`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok)
    throw new Error(`Could not download cloudflared: the server answered ${response.status}.`)
  const bytes = Buffer.from(await response.arrayBuffer())

  mkdirSync(binDir(), { recursive: true })
  const target = ownBinary()
  if (asset.archive) {
    const archive = join(binDir(), asset.file)
    writeFileSync(archive, bytes)
    try {
      execFileSync('tar', ['-xzf', archive, '-C', binDir()], { stdio: 'ignore' })
    } finally {
      rmSync(archive, { force: true })
    }
  } else {
    // Written under another name first, so an interrupted download never leaves a broken binary.
    const partial = `${target}.part`
    writeFileSync(partial, bytes)
    renameSync(partial, target)
  }
  if (process.platform !== 'win32') chmodSync(target, 0o755)
  if (!existsSync(target)) throw new Error('The cloudflared download did not contain the program.')
  log(`Saved to ${target}`)
  return target
}

function launch(bin: string, port: number, timeoutMs: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }

    let output = ''
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(error)
    }
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `cloudflared printed no tunnel address within ${timeoutMs / 1000}s.\n${output.slice(-600)}`,
          ),
        ),
      timeoutMs,
    )
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const match = TUNNEL_URL.exec(output)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ url: match[0], stop: () => child.kill() })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', fail)
    child.once('exit', (code) =>
      fail(
        new Error(
          `cloudflared exited with code ${code} before the tunnel was up.\n${output.slice(-600)}`,
        ),
      ),
    )
  })
}

/**
 * Starts a Cloudflare quick tunnel to the local port and resolves with its
 * public address. Fetches cloudflared first when the machine has none.
 */
export async function startQuickTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel> {
  if (!hasCloudflared()) await downloadCloudflared()
  let lastError: unknown
  for (const bin of cloudflaredCandidates()) {
    try {
      return await launch(bin, port, timeoutMs)
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(
    'cloudflared could not be started. Install it yourself, set MAJLIS_CLOUDFLARED to its path, ' +
      'or run with --no-tunnel.',
    { cause: lastError },
  )
}

/** A new quick-tunnel hostname takes a few seconds to resolve; wait until it answers. */
export async function waitUntilReachable(url: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
      if (response.ok) return true
    } catch {
      // Not resolvable or not routed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}
