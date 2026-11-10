/**
 * Screenshots a page in the installed Edge so a design can be checked by eye.
 * Usage: node scripts/shot.ts <url-or-file> <out-prefix> [width] [light|dark]
 * Writes <out-prefix>-full.png plus one viewport-sized slice per screen.
 */
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const [target, prefix, widthArg, scheme] = process.argv.slice(2)
if (!target || !prefix)
  throw new Error('Usage: node scripts/shot.ts <url-or-file> <out-prefix> [width] [light|dark]')

const width = Number(widthArg ?? 1200)
const height = 900
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({
  viewport: { width, height },
  colorScheme: scheme === 'dark' ? 'dark' : 'light',
})
const errors: string[] = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(/^https?:/.test(target) ? target : pathToFileURL(target).href)
await page.waitForTimeout(2600)

// Scroll through once so scroll-triggered animations have run before the full-page capture.
// Page-side code is passed as text: this project compiles without the DOM type library.
const total = Number(await page.evaluate('document.documentElement.scrollHeight'))
let slice = 0
for (let y = 0; y < total; y += height - 80) {
  await page.evaluate(`window.scrollTo(0, ${y})`)
  await page.waitForTimeout(1500)
  slice += 1
  await page.screenshot({ path: `${prefix}-${String(slice).padStart(2, '0')}.png` })
}
await page.screenshot({ path: `${prefix}-full.png`, fullPage: true })

const overflow = await page.evaluate(
  'document.documentElement.scrollWidth > document.documentElement.clientWidth',
)
console.log(`slices: ${slice}, page height: ${total}px, horizontal overflow: ${overflow}`)
console.log(errors.length > 0 ? `console errors:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
