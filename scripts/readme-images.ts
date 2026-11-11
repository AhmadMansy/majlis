/**
 * Regenerates everything the README shows that is not prose: screenshots of
 * the panel, of the approval step and of a report, taken from a real room
 * running the sample debate, and the comparison graphic, drawn from the table
 * in docs/comparison.html so the picture cannot drift from the page.
 * Run with `pnpm readme:images` after `pnpm build`. Uses the installed Edge;
 * the comparison graphic loads its two fonts from Google Fonts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type Browser, chromium, type Locator, type Page } from 'playwright'
import { startAdminServer } from '../src/admin.ts'
import { copyOutbound, hostOutbound } from '../src/outbound.ts'
import { Room } from '../src/room.ts'
import { startRoomServer } from '../src/server.ts'
import { RoomStore } from '../src/store.ts'
import { joinRoom, SyncClient } from '../src/sync.ts'
import {
  decide,
  describeSides,
  OMAR_ROUND_TWO,
  openSampleRoom,
  propose,
  publishReport,
  roundOne,
} from './sample-data.ts'

const root = join(import.meta.dirname, '..')
const out = join(root, 'docs', 'images')
/** Twice the CSS size, so the images stay sharp on high-density screens. */
const SCALE = 2

const save = (name: string): string => join(out, `${name}.png`)

async function connect(endpoint: string, token: string): Promise<Client> {
  const client = new Client({ name: 'sample-agent', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

const card = (page: Page, title: string): Locator =>
  page.locator('.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

// ── Screenshots of the app ──────────────────────────────────────────────

async function appScreenshots(browser: Browser): Promise<void> {
  const store = new RoomStore(':memory:')
  store.setKind('host')
  store.updateLocalSettings({ approval: 'auto' })
  const sample = openSampleRoom(store)
  const outbound = hostOutbound(sample.room)
  const server = await startRoomServer({ room: sample.room, port: 0, outbound, serveCopies: true })
  const admin = await startAdminServer({ room: sample.room, port: 0, outbound })
  const local = `http://127.0.0.1:${server.port}`
  // What a host with a tunnel sees. The address is an example, not a real room.
  sample.room.urls.public = 'https://example-room.trycloudflare.com'

  describeSides(sample)
  roundOne(sample)

  // Omar keeps a copy; his agent's next position waits there for his approval.
  const copyStore = new RoomStore(':memory:')
  const { me } = await joinRoom(copyStore, local, sample.tokens.Omar ?? '')
  const copyRoom = new Room(copyStore, 'tasmee-mobile')
  const copyOut = copyOutbound(copyStore)
  const sync = new SyncClient(copyStore, () => copyOut.flush())
  const copyServer = await startRoomServer({ room: copyRoom, port: 0, outbound: copyOut })
  const copyAdmin = await startAdminServer({ room: copyRoom, port: 0, outbound: copyOut, sync })
  sync.start()

  const agents = [
    await connect(`${local}/mcp`, sample.tokens.Ahmed ?? ''),
    await connect(`${local}/mcp`, sample.tokens.Sara ?? ''),
  ]
  const omarAgent = await connect(
    `http://127.0.0.1:${copyServer.port}/mcp`,
    copyStore.issueLocalToken(me.id),
  )
  // Reading the room is what marks a member as recently active.
  for (const agent of agents) await agent.callTool({ name: 'inbox', arguments: {} })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: SCALE,
  })
  try {
    // 1. The approval step, on the member's copy.
    const posting = omarAgent.callTool({
      name: 'post_position',
      arguments: { debate_id: sample.debateId, ...OMAR_ROUND_TWO },
    })
    const mine = await context.newPage()
    await mine.goto(copyAdmin.url)
    await mine.getByText('Waiting for your approval (1)').waitFor()
    await mine.waitForTimeout(600)
    const held = await mine.locator('.card', { has: mine.locator('.held') }).boundingBox()
    await mine.screenshot({
      path: save('approval'),
      clip: {
        x: 0,
        y: 0,
        width: 1280,
        height: Math.ceil((held?.y ?? 0) + (held?.height ?? 500)) + 24,
      },
    })
    await mine.getByRole('button', { name: 'Approve' }).click()
    await posting

    // 2. A debate waiting on a proposed resolution, and a pinned contract, as a member sees them.
    const proposal = propose(sample)
    await mine.getByText('Resolution: Fix it in the Android activity').waitFor()
    await card(mine, 'Debates').locator('.debate-toggle').first().click()
    await mine.getByText('Latest positions').waitFor()
    await card(mine, 'Debates').screenshot({ path: save('debate') })
    await card(mine, 'Pinned contracts').locator('.debate-toggle').first().click()
    await card(mine, 'Pinned contracts').locator('pre').waitFor()
    await card(mine, 'Pinned contracts').screenshot({ path: save('contracts') })
    await mine.close()

    // 3. The host's panel, in English and in Arabic.
    const page = await context.newPage()
    await page.goto(admin.url)
    await page.getByText('Resolution: Fix it in the Android activity').waitFor()
    await page.waitForTimeout(600)
    await page.screenshot({ path: save('panel') })
    await page.getByRole('button', { name: 'العربية' }).click()
    await page.getByText('المحادثة').waitFor()
    await page.evaluate('window.scrollTo(0, 0)')
    await page.waitForTimeout(400)
    await page.screenshot({ path: save('panel-ar') })
    await page.close()

    // 4. The report the agents publish after the decision.
    decide(sample, proposal)
    const report = publishReport(sample, 'en')
    const reportPage = await context.newPage()
    await reportPage.setViewportSize({ width: 1200, height: 900 })
    await reportPage.goto(`${local}/r/${report.key}`)
    await reportPage.waitForTimeout(2800)
    await reportPage.screenshot({ path: save('report') })
    // The confidence chart alone: its heading and plot, without the position cards below it.
    const chart = reportPage.locator('section', {
      has: reportPage.getByRole('heading', { name: 'How the positions moved' }),
    })
    await chart.scrollIntoViewIfNeeded()
    const scrolled = Number(await reportPage.evaluate('window.scrollY'))
    const before = await chart.boundingBox()
    await reportPage.evaluate(
      `window.scrollTo(0, ${Math.max(0, scrolled + (before?.y ?? 0) - 40)})`,
    )
    await reportPage.waitForTimeout(1800)
    const section = await chart.boundingBox()
    let plotBottom = 0
    for (const svg of await chart.locator('svg').all()) {
      const box = await svg.boundingBox()
      if (box && box.height > 150) plotBottom = Math.max(plotBottom, box.y + box.height)
    }
    if (!section || plotBottom === 0) throw new Error('The report has no confidence chart.')
    await reportPage.screenshot({
      path: save('report-positions'),
      clip: {
        x: section.x - 28,
        y: section.y - 28,
        width: section.width + 56,
        height: Math.ceil(plotBottom - section.y) + 28 + 27,
      },
    })
  } finally {
    await context.close()
    sync.stop()
    await Promise.all([...agents, omarAgent].map((agent) => agent.close().catch(() => undefined)))
    await copyAdmin.close()
    await copyServer.close()
    copyStore.close()
    await admin.close()
    await server.close()
    // A copy's last waiting request is answered as the server closes; let it finish first.
    await new Promise((resolve) => setTimeout(resolve, 400))
    store.close()
  }
}

// ── The comparison graphic ──────────────────────────────────────────────

type Mark = 'y' | 'p' | 'n' | 'x' | 'q'
interface Comparison {
  columns: string[]
  rows: Array<{ group: string } | { label: string; marks: Mark[] }>
}

/** Reads the feature table out of the comparison page. Runs in the browser, so it is passed as text. */
const READ_TABLE = `(() => {
  const table = document.querySelector('table')
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '')
  const columns = [...table.querySelectorAll('th[scope="col"]')].slice(1).map((th) => {
    const copy = th.cloneNode(true)
    for (const small of copy.querySelectorAll('small')) small.remove()
    return text(copy)
  })
  const rows = []
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.classList.contains('group')) rows.push({ group: text(tr) })
    else if (tr.querySelector('th[scope="row"]')) {
      rows.push({
        label: text(tr.querySelector('th[scope="row"]')),
        marks: [...tr.querySelectorAll('td')].map((td) => {
          const mark = td.querySelector('.m')
          return mark ? mark.className.split(' ')[1] : 'q'
        }),
      })
    }
  }
  return { columns, rows }
})()`

const ICON: Record<Mark, string> = {
  y: '<svg viewBox="0 0 20 20" role="img" aria-label="Yes"><circle cx="10" cy="10" r="9" fill="var(--yes)"/><path d="M5.9 10.3l2.8 2.8 5.5-6" fill="none" stroke="var(--on-yes)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  p: '<svg viewBox="0 0 20 20" role="img" aria-label="Partial"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--partial)" stroke-width="2"/><path d="M10 2a8 8 0 0 0 0 16z" fill="var(--partial)"/></svg>',
  n: '<svg viewBox="0 0 20 20" role="img" aria-label="No"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--absent)" stroke-width="2"/></svg>',
  x: '<svg viewBox="0 0 20 20" role="img" aria-label="Does not apply"><path d="M6 10h8" stroke="var(--absent)" stroke-width="2" stroke-linecap="round"/></svg>',
  q: '<svg viewBox="0 0 20 20" role="img" aria-label="Not stated"><text x="10" y="14.5" text-anchor="middle" font-size="13" font-weight="600" fill="var(--muted)">?</text></svg>',
}

const WORD: Record<Mark, string> = {
  y: 'Yes',
  p: 'Partial',
  n: 'No',
  x: 'n/a',
  q: 'Not stated',
}

const esc = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function comparisonPage(data: Comparison, date: string, dark: boolean): string {
  const others = data.columns.length - 1
  const head = data.columns
    .map((name, index) => `<th scope="col"${index === 0 ? ' class="us"' : ''}>${esc(name)}</th>`)
    .join('')
  const body = data.rows
    .map((row) => {
      if ('group' in row) {
        return `<tr class="group"><th scope="rowgroup">${esc(row.group)}</th><td class="us"></td><td colspan="${others}"></td></tr>`
      }
      const cells = row.marks
        .map((mark, index) => `<td${index === 0 ? ' class="us"' : ''}>${ICON[mark]}</td>`)
        .join('')
      return `<tr><th scope="row">${esc(row.label)}</th>${cells}</tr>`
    })
    .join('')
  const legend = (['y', 'p', 'n', 'x', 'q'] as const)
    .map((mark) => `<span>${ICON[mark]}${mark === 'x' ? 'Does not apply' : WORD[mark]}</span>`)
    .join('')
  return `<!doctype html>
<html lang="en"${dark ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --surface: #ffffff; --line: #dbe2df; --ink: #14201d; --ink-2: #45534f; --muted: #6b7773;
    --accent: #0d6e62; --wash: #e3f1ee; --yes: #0d6e62; --on-yes: #ffffff;
    --partial: #b26a00; --absent: #a3aeaa;
    --display: "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
    --body: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  }
  .dark {
    --surface: #151b23; --line: #2d353f; --ink: #e8eef2; --ink-2: #b3bdc6; --muted: #8a949e;
    --accent: #56cdb9; --wash: #17302d; --yes: #3fb9a5; --on-yes: #0b1512;
    --partial: #e0a23a; --absent: #5f6a75;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; }
  body { font-family: var(--body); color: var(--ink); -webkit-font-smoothing: antialiased; }
  .card { width: 880px; padding: 26px 22px 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; }
  .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 0 4px; }
  h1 { margin: 0; font-family: var(--display); font-size: 25px; font-weight: 700; letter-spacing: -0.015em; line-height: 1.15; }
  .sub { margin: 7px 0 0; max-width: 470px; font-size: 13.5px; line-height: 1.45; color: var(--ink-2); }
  .legend { display: grid; grid-template-columns: auto auto auto; gap: 7px 16px; font-size: 12px; color: var(--ink-2); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .legend svg { width: 15px; height: 15px; flex: none; }
  table { width: 100%; margin-top: 20px; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
  col.label { width: 268px; }
  thead th { padding: 12px 3px 11px; vertical-align: bottom; text-align: center; font-size: 11.5px; font-weight: 600; line-height: 1.25; color: var(--ink-2); }
  thead th.us { border-radius: 12px 12px 0 0; font-family: var(--display); font-size: 14.5px; font-weight: 700; color: var(--accent); }
  tbody th { padding: 9px 14px 9px 4px; border-top: 1px solid var(--line); text-align: left; font-size: 13px; font-weight: 400; line-height: 1.35; }
  tbody td { padding: 7px 0; border-top: 1px solid var(--line); text-align: center; vertical-align: middle; }
  tbody td svg { display: block; width: 19px; height: 19px; margin: 0 auto; }
  tr.group th { padding: 17px 4px 7px; border-top: 0; font-size: 10.5px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); }
  tr.group td { border-top: 0; }
  .us { background: var(--wash); }
  tbody tr:last-child td.us { border-radius: 0 0 12px 12px; }
  .foot { margin: 15px 4px 0; font-size: 11.5px; line-height: 1.5; color: var(--muted); }
</style>
</head>
<body>
<div class="card">
  <div class="top">
    <div>
      <h1>How Majlis compares</h1>
      <p class="sub">For one job: agents of different people, on different machines, settling a question and keeping the outcome.</p>
    </div>
    <div class="legend">${legend}</div>
  </div>
  <table>
    <colgroup><col class="label">${'<col>'.repeat(data.columns.length)}</colgroup>
    <thead><tr><td></td>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="foot">Compared on ${esc(date)} by the author of Majlis, so weigh it with that in mind. Marks for the other tools come from each tool's own page; the note behind every mark and the sources are in docs/comparison.html.</p>
</div>
</body>
</html>`
}

function comparisonMarkdown(data: Comparison): string {
  const lines = [
    `| | ${data.columns.map((name, index) => (index === 0 ? `**${name}**` : name)).join(' | ')} |`,
    `| --- | ${data.columns.map(() => ':---:').join(' | ')} |`,
  ]
  for (const row of data.rows) {
    if ('group' in row)
      lines.push(`| **${row.group}** | ${data.columns.map(() => '').join(' | ')} |`)
    else lines.push(`| ${row.label} | ${row.marks.map((mark) => WORD[mark]).join(' | ')} |`)
  }
  return lines.join('\n')
}

/** Replaces the text table between the two markers in the README with the current one. */
function updateReadme(table: string): void {
  const file = join(root, 'README.md')
  const readme = readFileSync(file, 'utf8')
  const start = '<!-- comparison-table:start -->'
  const end = '<!-- comparison-table:end -->'
  const from = readme.indexOf(start)
  const to = readme.indexOf(end)
  if (from < 0 || to < from) {
    console.log('README.md has no comparison-table markers; its text table was left alone.')
    return
  }
  writeFileSync(file, `${readme.slice(0, from + start.length)}\n\n${table}\n\n${readme.slice(to)}`)
}

async function comparisonGraphic(browser: Browser): Promise<void> {
  const source = join(root, 'docs', 'comparison.html')
  const date = /\d{1,2} [A-Z][a-z]+ \d{4}/.exec(readFileSync(source, 'utf8'))?.[0] ?? ''
  const context = await browser.newContext({
    viewport: { width: 960, height: 900 },
    deviceScaleFactor: SCALE,
  })
  try {
    const page = await context.newPage()
    await page.goto(pathToFileURL(source).href)
    const data = (await page.evaluate(READ_TABLE)) as Comparison
    if (data.columns[0] !== 'Majlis' || data.rows.length < 5) {
      throw new Error('The table in docs/comparison.html is not in the expected shape.')
    }
    for (const dark of [false, true]) {
      await page.setContent(comparisonPage(data, date, dark), { waitUntil: 'networkidle' })
      await page.evaluate('document.fonts.ready.then(() => true)')
      await page
        .locator('.card')
        .screenshot({ path: save(`comparison-${dark ? 'dark' : 'light'}`), omitBackground: true })
    }
    updateReadme(comparisonMarkdown(data))
  } finally {
    await context.close()
  }
}

mkdirSync(out, { recursive: true })
const only = process.argv[2]
const browser = await chromium.launch({ channel: 'msedge' })
try {
  if (only !== 'comparison') await appScreenshots(browser)
  if (only !== 'app') await comparisonGraphic(browser)
} finally {
  await browser.close()
}
console.log(`Wrote the README images to ${out}`)
process.exit(0)
