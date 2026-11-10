import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export interface Tunnel {
  url: string
  stop: () => void
}

/** Candidate cloudflared binaries, most specific first; the bare name relies on PATH. */
export function cloudflaredCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.MAJLIS_CLOUDFLARED) candidates.push(process.env.MAJLIS_CLOUDFLARED)
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  candidates.push(join(process.env.MAJLIS_HOME ?? join(homedir(), '.majlis'), 'bin', exe))
  if (process.platform === 'win32') {
    for (const root of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      if (root) candidates.push(join(root, 'cloudflared', 'cloudflared.exe'))
    }
  }
  return [...candidates.filter((path) => existsSync(path)), 'cloudflared']
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

/** Starts a Cloudflare quick tunnel to the local port and resolves with its public address. */
export async function startQuickTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel> {
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
    'cloudflared was not found. Install it (Windows: `winget install --id Cloudflare.cloudflared`), ' +
      'or set MAJLIS_CLOUDFLARED to its path, or run with --no-tunnel.',
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
