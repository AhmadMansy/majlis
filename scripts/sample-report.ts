/**
 * Builds sample reports from a made-up debate so the report design can be
 * judged without running a real room. Writes samples/report-*.html.
 * Run with `pnpm sample:report`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderReport } from '../src/report.ts'
import { type ReportContent, Room } from '../src/room.ts'
import { type Member, RoomStore } from '../src/store.ts'

const DIAGRAM = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 300" font-family="system-ui, Segoe UI, sans-serif">
  <rect width="720" height="300" fill="#ffffff"/>
  <text x="24" y="34" font-size="16" font-weight="700" fill="#0b0b0b">What happens when the app goes to the background</text>
  <g font-size="13" fill="#0b0b0b">
    <rect x="24" y="70" width="150" height="56" rx="10" fill="#eaf2fd" stroke="#2a78d6"/>
    <text x="99" y="103" text-anchor="middle">Activity.onPause</text>
    <rect x="214" y="70" width="170" height="56" rx="10" fill="#fdeee8" stroke="#eb6834"/>
    <text x="299" y="95" text-anchor="middle">Surface destroyed</text>
    <text x="299" y="113" text-anchor="middle" fill="#52514e" font-size="12">too early today</text>
    <rect x="424" y="70" width="150" height="56" rx="10" fill="#eaf2fd" stroke="#2a78d6"/>
    <text x="499" y="103" text-anchor="middle">Unity pause</text>
    <rect x="614" y="70" width="82" height="56" rx="10" fill="#fbe9e9" stroke="#d03b3b"/>
    <text x="655" y="103" text-anchor="middle">Crash</text>
  </g>
  <g stroke="#898781" stroke-width="2" fill="none" marker-end="url(#a)">
    <path d="M174 98h34"/><path d="M384 98h34"/><path d="M574 98h34"/>
  </g>
  <text x="24" y="178" font-size="14" font-weight="700" fill="#006300">After the fix</text>
  <g font-size="13" fill="#0b0b0b">
    <rect x="24" y="196" width="150" height="56" rx="10" fill="#eaf2fd" stroke="#2a78d6"/>
    <text x="99" y="229" text-anchor="middle">Activity.onPause</text>
    <rect x="214" y="196" width="150" height="56" rx="10" fill="#eaf2fd" stroke="#2a78d6"/>
    <text x="289" y="229" text-anchor="middle">Unity pause</text>
    <rect x="404" y="196" width="170" height="56" rx="10" fill="#e9f6e9" stroke="#0ca30c"/>
    <text x="489" y="229" text-anchor="middle">Surface released</text>
  </g>
  <g stroke="#898781" stroke-width="2" fill="none" marker-end="url(#a)">
    <path d="M174 224h34"/><path d="M364 224h34"/>
  </g>
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0l10 5-10 5z" fill="#898781"/></marker></defs>
</svg>`

function build(language: 'en' | 'ar'): string {
  const store = new RoomStore(':memory:')
  const room = new Room(store, 'tasmee-mobile')
  const ahmed = store.addMember('Ahmed', 'host').member
  const omar = store.addMember('Omar', 'member').member
  const sara = store.addMember('Sara', 'member').member
  const position = (
    member: Member,
    stance: string,
    confidence: number,
    reasoning: string,
    evidence: string[] = [],
  ) => room.postPosition(member, { debateId: 1, stance, confidence, reasoning, evidence })

  room.openDebate(ahmed, {
    question: 'Should the crash on resume be fixed in the Unity plugin or in the Android activity?',
    options: ['Unity plugin', 'Android activity'],
    context:
      'On some Android 14 devices the app crashes when it returns from the background while the recitation view is open.',
  })
  position(
    ahmed,
    'Android activity',
    60,
    'The native crash log shows the render surface is already gone when Unity receives its pause callback. The plugin cannot draw to a surface it no longer owns.',
    [
      'Plugins/Android/RecitationBridge.cs: OnApplicationPause fires after the surface error',
      'Reproduced 5/5 on a Pixel 8, API 34',
    ],
  )
  position(
    omar,
    'Unity plugin',
    70,
    'The activity follows the standard lifecycle. The plugin keeps a native texture handle across pause, and that is the usual cause of this crash.',
    ['RecitationActivity.kt: onPause calls super first, as the platform documents'],
  )
  position(
    sara,
    'Android activity',
    40,
    'From the design side, the pause overlay must appear before the screen goes dark. Whichever fix is chosen has to keep that order.',
  )
  room.send(ahmed, 'Omar, does the activity release the SurfaceView in onPause or in onStop?', null)
  room.send(
    omar,
    'Checked: onPause. A change last month moved it there to save memory. That is before Unity is told to pause.',
    4,
  )
  position(
    omar,
    'Android activity',
    85,
    'I was wrong about the handle. The release was moved into onPause last month, which runs before the Unity pause callback. Moving it back to onStop fixes the order without touching the plugin.',
    [
      'RecitationActivity.kt line 212: surfaceView.release() inside onPause',
      'git blame: moved on 14 Oct',
    ],
  )
  position(
    ahmed,
    'Android activity',
    90,
    'That matches the log. I will still add a guard in the plugin so a missing surface is skipped instead of crashing.',
  )
  const proposal = room.propose(omar, {
    debateId: 1,
    resolution:
      'Fix it in the Android activity: release the surface in onStop, after Unity has paused. The Unity plugin adds a guard as a second line of defence.',
    rationale:
      'The crash comes from the order of calls in the activity, introduced by a recent change. The plugin guard costs little and protects against the same mistake later.',
    actions: [
      { owner: 'Omar', action: 'Move surfaceView.release() from onPause to onStop' },
      { owner: 'Ahmed', action: 'Add a null-surface guard in RecitationBridge' },
      { owner: 'Sara', action: 'Confirm the pause overlay still shows first' },
    ],
  })
  room.respond(ahmed, { debateId: 1, proposal: proposal.seq, verdict: 'accept', note: '' })
  room.respond(sara, {
    debateId: 1,
    proposal: proposal.seq,
    verdict: 'accept',
    note: 'As long as the overlay order is tested on a real device.',
  })

  const content: ReportContent =
    language === 'en'
      ? {
          title: 'Resume crash: the fix belongs in the Android activity',
          summary:
            'The Unity and Android agents first disagreed about where the crash on resume should be fixed. After the Android agent checked a change made last month, both agreed the activity releases the render surface too early. The fix goes into the Android activity, with a small guard added on the Unity side.',
          what_was_done: [
            'Compared the order of lifecycle calls on the Unity and Android sides',
            'Traced the early surface release to a memory change made on 14 October',
            'Agreed a two-part fix and who owns each part',
          ],
          highlights: [
            'Each agent first blamed the other side; the disagreement ended when one piece of evidence was checked.',
            'The Android agent changed its position from Unity plugin to Android activity in round 2.',
            'The design requirement that the pause overlay shows first shaped the final wording.',
            'The fix is one moved line on Android plus a guard in the Unity plugin.',
          ],
          conclusion:
            'Release the surface in onStop instead of onPause, add a null-surface guard in the Unity plugin, and verify the pause overlay on a real device before release.',
          next_steps: [
            { owner: 'Omar', action: 'Open the Android pull request today' },
            { owner: 'Ahmed', action: 'Ship the plugin guard in the same release' },
            { owner: 'Sara', action: 'Test the overlay on a Pixel 8 and a Galaxy A54' },
          ],
          diagrams: [
            {
              title: 'Order of calls, before and after',
              caption: 'The surface must outlive the Unity pause callback.',
              svg: DIAGRAM,
            },
          ],
          language: 'en',
        }
      : {
          title: 'تعطل التطبيق عند العودة: الإصلاح مكانه نشاط أندرويد',
          summary:
            'اختلف وكيلا يونيتي وأندرويد في البداية حول مكان إصلاح التعطل عند العودة من الخلفية. بعد أن راجع وكيل أندرويد تعديلًا أُجري الشهر الماضي، اتفق الطرفان على أن النشاط يحرّر سطح العرض مبكرًا. الإصلاح في نشاط أندرويد، مع حماية صغيرة في جهة يونيتي.',
          what_was_done: [
            'مقارنة ترتيب استدعاءات دورة الحياة في جهتي يونيتي وأندرويد',
            'تتبع التحرير المبكر للسطح إلى تعديل للذاكرة بتاريخ 14 أكتوبر',
            'الاتفاق على إصلاح من جزأين وتحديد المسؤول عن كل جزء',
          ],
          highlights: [
            'ألقى كل وكيل اللوم على الجهة الأخرى أولًا، وانتهى الخلاف عند التحقق من دليل واحد.',
            'غيّر وكيل أندرويد موقفه في الجولة الثانية.',
            'شرط التصميم بظهور شاشة الإيقاف أولًا أثّر في صياغة القرار.',
          ],
          conclusion:
            'يُحرَّر السطح في onStop بدلًا من onPause، وتُضاف حماية في إضافة يونيتي، ويُختبر ظهور شاشة الإيقاف على جهاز حقيقي قبل الإصدار.',
          next_steps: [
            { owner: 'Omar', action: 'فتح طلب الدمج لأندرويد اليوم' },
            { owner: 'Ahmed', action: 'إضافة الحماية في الإصدار نفسه' },
          ],
          diagrams: [],
          language: 'ar',
        }

  const { report } = room.submitReport(omar, 1, content)
  room.signReport(ahmed, report.id, 'signoff', 'Fair summary of the Unity side.')
  room.signReport(
    sara,
    report.id,
    'dissent',
    'The overlay timing is only checked in the next step; I would have listed it as a condition of the decision.',
  )
  const html = renderReport(room, store.report(report.id) ?? report)
  store.close()
  return html
}

const out = join(import.meta.dirname, '..', 'samples')
mkdirSync(out, { recursive: true })
for (const language of ['en', 'ar'] as const) {
  const file = join(out, `report-${language}.html`)
  const html = build(language)
  writeFileSync(file, html)
  console.log(`${file}  (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`)
}
