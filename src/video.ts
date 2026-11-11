import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const WIDTH = 1280
const HEIGHT = 720
/** A replay of a very long conversation is cut off here so a recording always finishes. */
const MAX_REPLAY_MS = 8 * 60_000

interface BrowserLike {
  newContext: (options: unknown) => Promise<ContextLike>
  close: () => Promise<void>
}
interface ContextLike {
  newPage: () => Promise<PageLike>
  close: () => Promise<void>
}
interface PageLike {
  goto: (url: string, options?: unknown) => Promise<unknown>
  evaluate: (script: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
}
interface Launcher {
  launch: (options?: { channel?: string }) => Promise<BrowserLike>
}

/**
 * The recorder drives a browser already on the machine (Edge or Chrome), or
 * Playwright's own if one was installed. playwright-core is an optional
 * dependency, so the rest of the app works without it.
 */
async function openBrowser(): Promise<BrowserLike> {
  let chromium: Launcher
  try {
    // Kept out of the type checker's view: the package may legitimately be absent.
    const name = 'playwright-core'
    chromium = ((await import(name)) as { chromium: Launcher }).chromium
  } catch {
    throw new Error(
      'Recording needs the optional package playwright-core, which was not installed with Majlis. Install Majlis again without --omit=optional.',
    )
  }
  const failures: string[] = []
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launch(channel ? { channel } : {})
    } catch (error) {
      failures.push(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error))
    }
  }
  throw new Error(
    `No browser could be started for recording. Install Microsoft Edge or Google Chrome.\n${failures.join('\n')}`,
  )
}

/**
 * The browser records through a small ffmpeg build of Playwright's own, kept
 * in Playwright's cache folder. A new machine does not have it yet.
 */
function installEncoder(): void {
  const require = createRequire(import.meta.url)
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js')
  console.log('Downloading the video encoder (one time, a few MB)...')
  execFileSync(process.execPath, [cli, 'install', 'ffmpeg'], { stdio: 'inherit' })
}

/**
 * Records a report's animated replay to a WebM video: the opening, the
 * conversation played post by post, then the conclusion.
 */
export async function recordReport(url: string, outFile: string): Promise<string> {
  try {
    return await record(url, outFile)
  } catch (error) {
    if (!(error instanceof Error) || !/ffmpeg/i.test(error.message)) throw error
    installEncoder()
    return record(url, outFile)
  }
}

async function record(url: string, outFile: string): Promise<string> {
  const out = resolve(outFile)
  const dir = mkdtempSync(join(tmpdir(), 'majlis-video-'))
  const browser = await openBrowser()
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      recordVideo: { dir, size: { width: WIDTH, height: HEIGHT } },
      reducedMotion: 'no-preference',
    })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'load' })
    const hasPlayer = await page.evaluate('Boolean(document.querySelector("#play"))')
    if (!hasPlayer) throw new Error('That address is not a Majlis report with a replay.')

    // Opening: the title and the seats animating in.
    await page.waitForTimeout(3500)
    await page.evaluate(
      'document.getElementById("conversation").scrollIntoView({ behavior: "smooth" })',
    )
    await page.waitForTimeout(1200)
    await page.evaluate('document.getElementById("play").click()')

    const deadline = Date.now() + MAX_REPLAY_MS
    while (Date.now() < deadline) {
      await page.waitForTimeout(500)
      const done = await page.evaluate(
        '(() => { const [shown, total] = document.getElementById("count").textContent.split("/").map((n) => Number(n.trim())); return total > 0 && shown >= total })()',
      )
      if (done) break
    }
    // Let the last post be read, then close on the conclusion.
    await page.waitForTimeout(2500)
    await page.evaluate(
      '(() => { const end = document.querySelector(".conclusion"); if (end) end.scrollIntoView({ behavior: "smooth", block: "center" }) })()',
    )
    await page.waitForTimeout(4000)

    // The video file is complete only once its context has closed.
    await context.close()
    const recorded = readdirSync(dir).find((file) => file.endsWith('.webm'))
    if (!recorded) throw new Error('The browser produced no recording.')
    // Copied, not moved: the temporary folder may be on another drive than the destination.
    copyFileSync(join(dir, recorded), out)
    return out
  } finally {
    await browser.close().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}
