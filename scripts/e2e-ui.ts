/**
 * Drives the built control panel and a published report in the installed Edge:
 * a seeded room, then the host's own clicks. Needs `pnpm build` first.
 * Run with `pnpm e2e:ui [screenshot-folder]`.
 */
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { startAdminServer } from '../src/admin.ts'
import { Room } from '../src/room.ts'
import { startRoomServer } from '../src/server.ts'
import { RoomStore } from '../src/store.ts'

const shots = process.argv[2]
let failed = false
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  - ${detail}` : ''}`)
  if (!ok) failed = true
}
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}

const store = new RoomStore(':memory:')
const room = new Room(store, 'tasmee-mobile')
const ahmed = store.addMember('Ahmed', 'host').member
const omar = store.addMember('Omar', 'member').member
const server = await startRoomServer({ room, port: 0 })
const admin = await startAdminServer({ room, port: 0 })

room.send(
  ahmed,
  'Omar, the app crashes on resume on Android 14. Can your agent look at the activity side?',
  null,
)
room.send(
  omar,
  'Looking now. I will open a debate so both agents put their evidence in one place.',
  1,
)
room.openDebate(omar, {
  question: 'Should the resume crash be fixed in the Unity plugin or in the Android activity?',
  options: ['Unity plugin', 'Android activity'],
  context: 'Crash when returning from the background while the recitation view is open.',
})
room.postPosition(ahmed, {
  debateId: 1,
  stance: 'Android activity',
  confidence: 60,
  reasoning: 'The surface is already gone when Unity receives its pause callback.',
  evidence: ['Reproduced 5/5 on a Pixel 8, API 34'],
})
room.postPosition(omar, {
  debateId: 1,
  stance: 'Android activity',
  confidence: 85,
  reasoning: 'The release was moved into onPause last month; it must go back to onStop.',
  evidence: ['RecitationActivity.kt line 212'],
})
const proposal = room.propose(omar, {
  debateId: 1,
  resolution: 'Release the surface in onStop, after Unity has paused.',
  rationale: 'The order of calls in the activity causes the crash.',
  actions: [{ owner: 'Omar', action: 'Move the release to onStop' }],
})

const browser = await chromium.launch({ channel: 'msedge' })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  // ── Control panel ───────────────────────────────────────────────────────
  await page.goto(admin.url)
  await page.getByText('Looking now.').waitFor()
  check('panel shows the conversation', (await page.locator('.msg').count()) === 6)
  check('panel key is removed from the address bar', !page.url().includes('key='))
  check(
    'panel lists both members',
    (await page.locator('.card', { hasText: 'Members' }).locator('li').count()) === 2,
  )
  await shot(page, 'panel-1-overview')

  await page.getByPlaceholder('Name').fill('Sara')
  await page.getByRole('button', { name: 'Invite' }).click()
  const dialog = page.locator('dialog')
  await dialog.waitFor()
  const command = (await dialog.locator('pre').first().textContent()) ?? ''
  check(
    'inviting shows a Claude Code command with a token',
    /claude mcp add .*Bearer [\w-]{20,}/.test(command),
  )
  await shot(page, 'panel-2-invite')
  await dialog.getByRole('button', { name: 'Done' }).click()
  check('the new member is stored', store.memberByName('Sara') !== undefined)

  await page.getByRole('button', { name: 'Pause room' }).click()
  await page.getByRole('button', { name: 'Resume room' }).waitFor()
  check('pause button pauses the room', store.settings().paused === true)
  await page.getByRole('button', { name: 'Resume room' }).click()
  await page.getByRole('button', { name: 'Pause room' }).waitFor()

  await page.locator('#compose').fill('Good. Ship it in this release.')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText('Good. Ship it in this release.').waitFor()
  check('host message is marked as typed by the human', store.history(1)[0]?.data.via === 'human')

  await page.locator('.debate-toggle').click()
  await page.getByText('Latest positions').waitFor()
  await shot(page, 'panel-3-debate')

  // An agent accepts while the panel is open: the panel must pick it up on its own.
  room.respond(ahmed, { debateId: 1, proposal: proposal.seq, verdict: 'accept', note: '' })
  await page.locator('.debate-toggle .st-decided').waitFor({ timeout: 8000 })
  check('panel follows a decision made by the agents', true)
  await page.getByText('Decision record').waitFor()

  const { url } = room.submitReport(omar, 1, {
    title: 'Resume crash: fix goes to Android',
    summary:
      'Both agents traced the crash to the activity lifecycle and agreed on an Android-side fix.',
    what_was_done: ['Compared lifecycle order on both sides'],
    highlights: ['The surface is destroyed before Unity pauses'],
    conclusion: 'The Android activity will release the surface in onStop.',
    next_steps: [{ owner: 'Omar', action: 'Open the pull request' }],
    diagrams: [],
    language: 'en',
  })
  await page
    .locator('.card', { hasText: 'Reports' })
    .getByText('Resume crash: fix goes to Android')
    .waitFor({ timeout: 8000 })
  check('panel lists the published report', true)
  const newestVisible = await page.evaluate(
    `(() => { const feed = document.querySelector('.feed').getBoundingClientRect(); const last = document.querySelector('.msg:last-of-type').getBoundingClientRect(); return last.bottom <= feed.bottom + 2 && last.top >= feed.top })()`,
  )
  check('conversation follows the newest post', newestVisible === true)

  await page.getByRole('button', { name: 'العربية' }).click()
  await page.getByText('المحادثة').waitFor()
  check(
    'panel switches to Arabic and right-to-left',
    (await page.getAttribute('html', 'dir')) === 'rtl',
  )
  await shot(page, 'panel-4-arabic')

  // ── Report ──────────────────────────────────────────────────────────────
  const report = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  report.on('pageerror', (error) => errors.push(error.message))
  await report.goto(url)
  const total = await report.locator('.tl-item').count()
  await report.locator('#play').click()
  await report.waitForTimeout(2200)
  const shown = await report.locator('.tl-item.shown').count()
  check(
    'report replay reveals posts one at a time',
    shown >= 1 && shown < total,
    `${shown} of ${total} after 2s`,
  )
  await shot(report, 'report-replay')
  await report.locator('#all').click()
  check(
    'report "show all" ends the replay',
    (await report.locator('.timeline.replaying').count()) === 0,
  )

  check('no browser errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  await admin.close()
  await server.close()
  store.close()
}
process.exit(failed ? 1 : 0)
