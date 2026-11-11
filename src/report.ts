import type { DebateView, ReportContent, Room } from './room.ts'
import type { Action, RoomEvent, StoredReport } from './store.ts'

/**
 * Renders a report as one self-contained HTML page: no external requests,
 * agent-written text always escaped, agent-drawn diagrams embedded as inert
 * images. The page design belongs to the app; agents only supply content.
 */

type Lang = 'en' | 'ar'

const LABELS = {
  en: {
    eyebrow: 'Majlis report',
    room: 'Room',
    debateReport: 'Debate report',
    conversationReport: 'Conversation report',
    question: 'The question',
    decidedAgreement: 'Decided by agreement',
    decidedHumans: 'Decided by the humans',
    messages: 'Posts',
    participants: 'Participants',
    rounds: 'Rounds of positions',
    duration: 'From first post to last',
    decision: 'The decision',
    rationale: 'Why',
    acceptedBy: 'Accepted by',
    recordedBy: 'Recorded by',
    actions: 'Who does what',
    owner: 'Owner',
    action: 'Action',
    summary: 'In short',
    done: 'What was done',
    highlights: 'Highlights',
    positions: 'How the positions moved',
    positionsLead: 'Each participant’s own stated confidence, round by round.',
    finalConfidence: 'Stated confidence in their position',
    round: 'Round',
    confidence: 'confidence',
    stance: 'Stance',
    evidence: 'Evidence',
    diagrams: 'Diagrams',
    replay: 'The conversation',
    replayLead: 'Every post in order, in the participants’ own words.',
    play: 'Play replay',
    pause: 'Pause',
    resume: 'Resume',
    showAll: 'Show all',
    speed: 'Speed',
    showMore: 'Show more',
    showLess: 'Show less',
    conclusion: 'Conclusion',
    nextSteps: 'Next steps',
    notes: 'Sign-offs and dissent',
    signoff: 'Signed off',
    dissent: 'Dissent',
    crux: 'Why it went to the humans',
    typedByHuman: 'typed by the human',
    footer: (author: string) =>
      `The summary, highlights and conclusion were written by ${author}’s agent. The decision, positions and conversation are taken verbatim from the room log.`,
    kinds: {
      message: '',
      debate_opened: 'Opened the debate',
      position: 'Position',
      proposal: 'Proposed a resolution',
      accept: 'Accepted',
      reject: 'Rejected',
      escalation: 'Escalated to the humans',
      decision: 'Decision',
      profile: 'Described their side',
      contract: 'Pinned a contract',
    },
    units: { min: 'min', h: 'h', d: 'd', lessMin: 'under 1 min' },
    council: (n: number) => `${n} participants around the table`,
  },
  ar: {
    eyebrow: 'تقرير المجلس',
    room: 'الغرفة',
    debateReport: 'تقرير نقاش',
    conversationReport: 'تقرير محادثة',
    question: 'السؤال',
    decidedAgreement: 'حُسم بالاتفاق',
    decidedHumans: 'حسمه أصحاب القرار',
    messages: 'المشاركات',
    participants: 'المشاركون',
    rounds: 'جولات المواقف',
    duration: 'من أول مشاركة إلى آخرها',
    decision: 'القرار',
    rationale: 'السبب',
    acceptedBy: 'وافق عليه',
    recordedBy: 'سجّله',
    actions: 'من يفعل ماذا',
    owner: 'المسؤول',
    action: 'المهمة',
    summary: 'الخلاصة',
    done: 'ما الذي تم',
    highlights: 'أبرز النقاط',
    positions: 'كيف تحركت المواقف',
    positionsLead: 'درجة الثقة التي أعلنها كل مشارك، جولة بعد جولة.',
    finalConfidence: 'درجة الثقة المعلنة في الموقف',
    round: 'الجولة',
    confidence: 'ثقة',
    stance: 'الموقف',
    evidence: 'الأدلة',
    diagrams: 'الرسوم التوضيحية',
    replay: 'المحادثة',
    replayLead: 'كل مشاركة بالترتيب وبكلمات أصحابها.',
    play: 'تشغيل العرض',
    pause: 'إيقاف مؤقت',
    resume: 'متابعة',
    showAll: 'عرض الكل',
    speed: 'السرعة',
    showMore: 'عرض المزيد',
    showLess: 'عرض أقل',
    conclusion: 'الخاتمة',
    nextSteps: 'الخطوات التالية',
    notes: 'الموافقات والاعتراضات',
    signoff: 'موافقة',
    dissent: 'اعتراض',
    crux: 'لماذا رُفع إلى أصحاب القرار',
    typedByHuman: 'كتبه الإنسان',
    footer: (author: string) =>
      `كتب الخلاصة وأبرز النقاط والخاتمة وكيل ${author}. أما القرار والمواقف والمحادثة فمنقولة حرفيًا من سجل الغرفة.`,
    kinds: {
      message: '',
      debate_opened: 'فتح النقاش',
      position: 'موقف',
      proposal: 'اقترح حلًا',
      accept: 'وافق',
      reject: 'رفض',
      escalation: 'رفعه إلى أصحاب القرار',
      decision: 'القرار',
      profile: 'عرّف بجهته',
      contract: 'ثبّت عقدًا مشتركًا',
    },
    units: { min: 'د', h: 'س', d: 'ي', lessMin: 'أقل من دقيقة' },
    council: (n: number) => `${n} مشاركين حول الطاولة`,
  },
} as const

type Labels = (typeof LABELS)[Lang]

const SERIES_SLOTS = 8

export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?']
  return letters
    .map((word) => Array.from(word ?? '?')[0] ?? '?')
    .join('')
    .toUpperCase()
}

function duration(ms: number, t: Labels): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return t.units.lessMin
  if (minutes < 60) return `${minutes} ${t.units.min}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${t.units.h} ${minutes % 60} ${t.units.min}`
  return `${Math.floor(hours / 24)} ${t.units.d} ${hours % 24} ${t.units.h}`
}

const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
const time = (iso: string): string => `<time datetime="${esc(iso)}">${esc(utc(iso))}</time>`

function normalize(raw: Record<string, unknown>): ReportContent {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const texts = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const objects = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
      : []
  return {
    title: text(raw.title),
    summary: text(raw.summary),
    what_was_done: texts(raw.what_was_done),
    highlights: texts(raw.highlights),
    conclusion: text(raw.conclusion),
    next_steps: objects(raw.next_steps).map((s) => ({
      owner: text(s.owner),
      action: text(s.action),
    })),
    diagrams: objects(raw.diagrams).map((d) => ({
      title: text(d.title),
      caption: text(d.caption),
      svg: text(d.svg),
    })),
    language: raw.language === 'ar' ? 'ar' : 'en',
  }
}

interface Person {
  name: string
  /** Categorical colour slot 1-8, fixed by the member's place in the room; 0 beyond the palette. */
  slot: number
}

function avatar(person: Person | undefined, name: string, size = ''): string {
  const slot = person?.slot ?? 0
  return `<span class="av s${slot} ${size}" style="--c:var(--s${slot})" aria-hidden="true">${esc(initials(name))}</span>`
}

// ── Illustration: the participants seated around the table ─────────────────

function council(people: Person[], decided: boolean, t: Labels): string {
  const seats = people.slice(0, SERIES_SLOTS)
  const cx = 180
  const cy = 170
  const radius = 112
  const parts: string[] = []
  seats.forEach((person, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(seats.length, 1)
    const x = cx + radius * Math.cos(angle)
    const y = cy + radius * Math.sin(angle)
    const label = person.name.length > 14 ? `${person.name.slice(0, 13)}…` : person.name
    const labelY = y > cy ? y + 46 : y - 36
    parts.push(
      `<line class="beam" x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${cx}" y2="${cy}" stroke="var(--s${person.slot})" style="--i:${index}"/>`,
      `<g class="seat" style="--i:${index}">` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="29" fill="var(--surface)"/>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="26" fill="var(--s${person.slot})"/>` +
        `<text class="seat-in s${person.slot}" x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle">${esc(initials(person.name))}</text>` +
        `<text class="seat-name" x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${esc(label)}</text>` +
        `</g>`,
    )
  })
  const centre = decided
    ? `<circle class="hub ok" cx="${cx}" cy="${cy}" r="30"/><path class="tick" d="M${cx - 12} ${cy + 1} l8 9 l16 -18" pathLength="1"/>`
    : `<circle class="hub" cx="${cx}" cy="${cy}" r="30"/><circle class="dot d1" cx="${cx - 10}" cy="${cy}" r="3.5"/><circle class="dot d2" cx="${cx}" cy="${cy}" r="3.5"/><circle class="dot d3" cx="${cx + 10}" cy="${cy}" r="3.5"/>`
  return (
    `<svg class="council" viewBox="0 0 360 340" role="img" aria-label="${esc(t.council(seats.length))}">` +
    `<circle class="table" cx="${cx}" cy="${cy}" r="${radius}"/>` +
    `<circle class="table inner" cx="${cx}" cy="${cy}" r="62"/>` +
    parts.join('') +
    centre +
    `</svg>`
  )
}

// ── Charts ─────────────────────────────────────────────────────────────────

/** Confidence per round, one line per participant. Used when someone posted two or more positions. */
function confidenceLines(view: DebateView, people: Map<string, Person>, t: Labels): string {
  const rounds = Math.max(...view.positions.map((p) => p.round))
  const width = 680
  const height = 280
  const left = 44
  const right = 150
  const top = 16
  const bottom = 36
  const plotW = width - left - right
  const plotH = height - top - bottom
  const x = (round: number) =>
    left + (rounds === 1 ? plotW / 2 : ((round - 1) * plotW) / (rounds - 1))
  const y = (value: number) => top + plotH - (value / 100) * plotH

  const grid = [0, 25, 50, 75, 100]
    .map(
      (tick) =>
        `<line class="${tick === 0 ? 'axis' : 'grid'}" x1="${left}" x2="${left + plotW}" y1="${y(tick)}" y2="${y(tick)}"/>` +
        `<text class="tick-label" x="${left - 8}" y="${y(tick) + 4}" text-anchor="end">${tick}%</text>`,
    )
    .join('')
  const xTicks = Array.from({ length: rounds }, (_, i) => i + 1)
    .map(
      (round) =>
        `<text class="tick-label" x="${x(round)}" y="${height - 12}" text-anchor="middle">${esc(t.round)} ${round}</text>`,
    )
    .join('')

  const series = view.participants
    .map((name) => ({
      name,
      slot: people.get(name)?.slot ?? 0,
      points: view.positions.filter((p) => p.member === name),
    }))
    .filter((s) => s.points.length > 0)

  // End labels are spread apart when lines finish close together; a leader keeps each tied to its line.
  const ends = series
    .map((s) => {
      const last = s.points.at(-1)
      return {
        name: s.name,
        slot: s.slot,
        x: x(last?.round ?? 1),
        y: y(last?.confidence ?? 0),
        labelY: 0,
        value: last?.confidence ?? 0,
        // A participant who stopped early is labelled at their last point, not in the end gutter.
        atEdge: (last?.round ?? 1) === rounds,
      }
    })
    .sort((a, b) => a.y - b.y)
  const edge = ends.filter((end) => end.atEdge)
  let previous = Number.NEGATIVE_INFINITY
  for (const end of edge) {
    end.labelY = Math.max(end.y, previous + 16)
    previous = end.labelY
  }
  const overflow = Math.max(0, previous - (top + plotH))
  for (const end of edge) end.labelY -= overflow

  const marks = series
    .map((s, index) => {
      const path = s.points
        .map(
          (p, i) => `${i === 0 ? 'M' : 'L'}${x(p.round).toFixed(1)} ${y(p.confidence).toFixed(1)}`,
        )
        .join(' ')
      const dots = s.points
        .map(
          (p) =>
            `<circle class="pt" cx="${x(p.round).toFixed(1)}" cy="${y(p.confidence).toFixed(1)}" r="5" fill="var(--s${s.slot})" tabindex="0" data-tip="${esc(`${s.name} · ${t.round} ${p.round} · ${p.confidence}% · ${p.stance}`)}"><title>${esc(`${s.name}, ${t.round} ${p.round}: ${p.confidence}% (${p.stance})`)}</title></circle>`,
        )
        .join('')
      return `<g style="--i:${index}"><path class="ln" d="${path}" stroke="var(--s${s.slot})" pathLength="1"/>${dots}</g>`
    })
    .join('')

  const labels = ends
    .map((end) => {
      const text = `${esc(end.name.length > 13 ? `${end.name.slice(0, 12)}…` : end.name)} ${end.value}%`
      if (!end.atEdge) {
        return `<text class="end-label" x="${end.x + 12}" y="${end.y + 4}">${text}</text>`
      }
      return (
        `<line class="leader" x1="${end.x + 8}" y1="${end.y}" x2="${left + plotW + 14}" y2="${end.labelY}"/>` +
        `<text class="end-label" x="${left + plotW + 18}" y="${end.labelY + 4}">${text}</text>`
      )
    })
    .join('')

  const legend =
    series.length > 1
      ? `<div class="legend">${series.map((s) => `<span><i style="--c:var(--s${s.slot})"></i>${esc(s.name)}</span>`).join('')}</div>`
      : ''

  // The plot keeps left-to-right time even in an Arabic report, as charts conventionally do.
  return `${legend}<div class="chart" dir="ltr"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t.positions)}">${grid}${xTicks}${marks}${labels}</svg></div>`
}

/** One meter per participant: used when everyone posted a single position, where a line has nothing to show. */
function confidenceMeters(view: DebateView, people: Map<string, Person>): string {
  return `<div class="meters">${view.participants
    .map((name) => {
      const latest = view.positions.filter((p) => p.member === name).at(-1)
      if (!latest) return ''
      const slot = people.get(name)?.slot ?? 0
      return (
        `<div class="meter" style="--c:var(--s${slot})">` +
        `<div class="meter-name">${avatar(people.get(name), name, 'sm')}<b>${esc(name)}</b><span dir="auto">${esc(latest.stance)}</span></div>` +
        `<div class="meter-track"><div class="meter-fill" style="--w:${latest.confidence}%"></div></div>` +
        `<div class="meter-value">${latest.confidence}%</div></div>`
      )
    })
    .join('')}</div>`
}

// ── Sections ───────────────────────────────────────────────────────────────

function actionTable(actions: Action[], people: Map<string, Person>, t: Labels): string {
  if (actions.length === 0) return ''
  return `<table class="steps"><thead><tr><th>${esc(t.owner)}</th><th>${esc(t.action)}</th></tr></thead><tbody>${actions
    .map(
      (a) =>
        `<tr><td><span class="who">${people.has(a.owner) ? avatar(people.get(a.owner), a.owner, 'sm') : ''}${esc(a.owner)}</span></td><td dir="auto">${esc(a.action)}</td></tr>`,
    )
    .join('')}</tbody></table>`
}

function positionsSection(view: DebateView, people: Map<string, Person>, t: Labels): string {
  if (view.positions.length === 0) return ''
  const multiRound = view.positions.some((p) => p.round > 1)
  const chart = multiRound
    ? confidenceLines(view, people, t)
    : `<p class="chart-title">${esc(t.finalConfidence)}</p>${confidenceMeters(view, people)}`
  const cards = view.participants
    .map((name) => {
      const own = view.positions.filter((p) => p.member === name)
      if (own.length === 0) return ''
      return (
        `<article class="pos reveal"><header>${avatar(people.get(name), name)}<h3>${esc(name)}</h3></header>` +
        own
          .map(
            (p) =>
              `<div class="pos-round"><div class="pos-meta"><span class="pill">${esc(t.round)} ${p.round}</span><b dir="auto">${esc(p.stance)}</b><span class="muted">${p.confidence}% ${esc(t.confidence)}</span></div>` +
              `<p class="quote" dir="auto">${esc(p.reasoning)}</p>` +
              (p.evidence.length > 0
                ? `<p class="mini">${esc(t.evidence)}</p><ul class="evidence">${p.evidence.map((e) => `<li dir="auto">${esc(e)}</li>`).join('')}</ul>`
                : '') +
              `</div>`,
          )
          .join('') +
        `</article>`
      )
    })
    .join('')
  return `<section class="reveal"><h2>${esc(t.positions)}</h2><p class="lead">${esc(t.positionsLead)}</p><div class="card">${chart}</div><div class="pos-grid">${cards}</div></section>`
}

function timeline(events: RoomEvent[], people: Map<string, Person>, t: Labels): string {
  const items = events
    .map((event) => {
      let kind: string = ''
      if (event.kind === 'response')
        kind = event.data.verdict === 'accept' ? t.kinds.accept : t.kinds.reject
      else if (event.kind === 'position')
        kind = `${t.kinds.position} · ${t.round} ${Number(event.data.round ?? 1)}`
      else if (event.kind !== 'report') kind = t.kinds[event.kind]
      const human =
        event.data.via === 'human' ? `<span class="pill">${esc(t.typedByHuman)}</span>` : ''
      const long = event.body.length > 700 ? ' long' : ''
      return (
        `<li class="tl-item k-${event.kind}" data-len="${event.body.length}">${avatar(people.get(event.authorName), event.authorName)}` +
        `<div class="tl-card"><div class="tl-head"><b>${esc(event.authorName)}</b>${kind ? `<span class="pill">${esc(kind)}</span>` : ''}${human}<span class="muted">#${event.seq} · ${time(event.ts)}</span></div>` +
        `<div class="tl-body${long}" dir="auto">${esc(event.body)}</div>` +
        (long
          ? `<button class="more" type="button" data-more="${esc(t.showMore)}" data-less="${esc(t.showLess)}">${esc(t.showMore)}</button>`
          : '') +
        `</div></li>`
      )
    })
    .join('')
  return (
    `<section id="conversation"><h2 class="reveal">${esc(t.replay)}</h2><p class="lead reveal">${esc(t.replayLead)}</p>` +
    `<div class="player" hidden><button id="play" type="button" class="btn primary" data-play="${esc(t.play)}" data-pause="${esc(t.pause)}" data-resume="${esc(t.resume)}">${esc(t.play)}</button>` +
    `<button id="all" type="button" class="btn">${esc(t.showAll)}</button>` +
    `<button id="speed" type="button" class="btn" aria-label="${esc(t.speed)}">1×</button>` +
    `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${events.length}" aria-valuenow="0"><i></i></div><span id="count" class="muted">0 / ${events.length}</span></div>` +
    `<ol class="timeline">${items}</ol></section>`
  )
}

const ICON_CHECK = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`

export function renderReport(room: Room, report: StoredReport): string {
  const content = normalize(report.content)
  const lang: Lang = content.language
  const t = LABELS[lang]
  const view = report.debateId === null ? null : room.debateView(report.debateId)
  // A debate report also shows the free messages exchanged while the debate ran, but not other debates.
  const events = room.store
    .eventsBetween(report.fromSeq, report.toSeq)
    .filter(
      (event) =>
        event.kind !== 'report' &&
        (view === null || event.debateId === null || event.debateId === view.debate.id),
    )

  // Colour follows the member, not their rank in this report: the slot is their place in the room.
  const roster = room.store.members().map((member) => member.name)
  const present = [...new Set(events.map((event) => event.authorName))]
  for (const name of present) if (!roster.includes(name)) roster.push(name)
  const people = new Map<string, Person>()
  roster.forEach((name, index) => {
    people.set(name, { name, slot: index < SERIES_SLOTS ? index + 1 : 0 })
  })
  const seated = roster
    .filter((name) => present.includes(name))
    .map((name) => people.get(name) as Person)

  const decision = view?.debate.decision ?? null
  const first = events[0]
  const last = events.at(-1)
  const rounds = view ? Math.max(0, ...view.positions.map((p) => p.round)) : 0
  const kpis: Array<[string, string]> = [
    [String(events.length), t.messages],
    [String(seated.length), t.participants],
  ]
  if (rounds > 0) kpis.push([String(rounds), t.rounds])
  if (first && last)
    kpis.push([duration(Date.parse(last.ts) - Date.parse(first.ts), t), t.duration])

  const badge = decision
    ? `<span class="badge ok">${ICON_CHECK}${esc(decision.decidedBy === 'agreement' ? t.decidedAgreement : t.decidedHumans)}</span>`
    : ''

  const hero =
    `<header class="hero"><div class="hero-text">` +
    `<p class="eyebrow">${esc(t.eyebrow)} · ${esc(view ? t.debateReport : t.conversationReport)}</p>` +
    `<h1 dir="auto">${esc(content.title)}</h1>` +
    (view
      ? `<p class="question"><span>${esc(t.question)}</span><bdi>${esc(view.debate.question)}</bdi></p>`
      : '') +
    `<div class="hero-meta">${badge}<span class="muted">${esc(t.room)}: ${esc(room.name)}</span>${last ? `<span class="muted">${time(last.ts)}</span>` : ''}</div>` +
    `<div class="chips">${seated.map((p) => `<span class="chip">${avatar(p, p.name, 'sm')}${esc(p.name)}</span>`).join('')}</div>` +
    `</div><div class="hero-art">${council(seated, decision !== null, t)}</div></header>`

  const kpiRow = `<section class="kpis reveal">${kpis
    .map(([value, label]) => {
      const numeric = /^\d+$/.test(value)
      return `<div class="kpi"><div class="kpi-value${numeric ? '' : ' words'}"${numeric ? ` data-count="${value}"` : ''}>${esc(value)}</div><div class="kpi-label">${esc(label)}</div></div>`
    })
    .join('')}</section>`

  const decisionCard = decision
    ? `<section class="decision reveal"><p class="mini">${esc(t.decision)}</p><p class="resolution" dir="auto">${esc(decision.resolution)}</p>` +
      `<p class="mini">${esc(t.rationale)}</p><p class="pre" dir="auto">${esc(decision.rationale)}</p>` +
      (decision.acceptedBy.length > 0
        ? `<p class="mini">${esc(t.acceptedBy)}</p><div class="chips">${decision.acceptedBy.map((name) => `<span class="chip">${avatar(people.get(name), name, 'sm')}${esc(name)}</span>`).join('')}</div>`
        : `<p class="muted">${esc(t.recordedBy)}: ${esc(decision.recordedBy)}</p>`) +
      (decision.actions.length > 0
        ? `<p class="mini">${esc(t.actions)}</p>${actionTable(decision.actions, people, t)}`
        : '') +
      (view?.escalation
        ? `<p class="mini">${esc(t.crux)}</p><p class="pre" dir="auto">${esc(view.escalation.crux)}</p>`
        : '') +
      `</section>`
    : ''

  const summary =
    `<section class="reveal"><h2>${esc(t.summary)}</h2><p class="summary pre" dir="auto">${esc(content.summary)}</p>` +
    (content.what_was_done.length > 0
      ? `<h3>${esc(t.done)}</h3><ul class="done">${content.what_was_done.map((item) => `<li>${ICON_CHECK}<span dir="auto">${esc(item)}</span></li>`).join('')}</ul>`
      : '') +
    `</section>`

  const highlights =
    content.highlights.length > 0
      ? `<section><h2 class="reveal">${esc(t.highlights)}</h2><ol class="highlights">${content.highlights.map((item, index) => `<li class="reveal" style="--i:${index}"><span class="num">${index + 1}</span><p dir="auto">${esc(item)}</p></li>`).join('')}</ol></section>`
      : ''

  const diagrams =
    content.diagrams.length > 0
      ? `<section class="reveal"><h2>${esc(t.diagrams)}</h2><div class="figures">${content.diagrams
          .map(
            (d) =>
              `<figure><img alt="${esc(d.title)}" src="data:image/svg+xml;base64,${Buffer.from(d.svg, 'utf8').toString('base64')}"><figcaption><b>${esc(d.title)}</b>${d.caption ? ` — ${esc(d.caption)}` : ''}</figcaption></figure>`,
          )
          .join('')}</div></section>`
      : ''

  const closing =
    `<section class="reveal"><h2>${esc(t.conclusion)}</h2><blockquote class="conclusion pre" dir="auto">${esc(content.conclusion)}</blockquote>` +
    (content.next_steps.length > 0
      ? `<h3>${esc(t.nextSteps)}</h3>${actionTable(content.next_steps, people, t)}`
      : '') +
    `</section>`

  const notes =
    report.notes.length > 0
      ? `<section class="reveal"><h2>${esc(t.notes)}</h2><ul class="notes">${report.notes
          .map(
            (note) =>
              `<li class="${note.kind}">${avatar(people.get(note.member), note.member, 'sm')}<div><b>${esc(note.member)}</b> <span class="pill">${esc(note.kind === 'signoff' ? t.signoff : t.dissent)}</span><p class="pre" dir="auto">${esc(note.note)}</p></div></li>`,
          )
          .join('')}</ul></section>`
      : ''

  const body = [
    hero,
    kpiRow,
    decisionCard,
    summary,
    highlights,
    view ? positionsSection(view, people, t) : '',
    diagrams,
    timeline(events, people, t),
    closing,
    notes,
    `<footer><p>${esc(t.footer(report.author))}</p><p class="muted">Majlis · ${time(report.updatedAt)}</p></footer>`,
  ].join('\n')

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${esc(content.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
<div id="tip" role="status" hidden></div>
<script>${SCRIPT}</script>
</body>
</html>
`
}

const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6d68;--line:#e1e0d9;--axis:#c3c2b7;--accent:#2a78d6;--good:#0ca30c;--good-ink:#006300;--good-wash:#e9f6e9;--ring:rgba(11,11,11,.10);--shadow:0 1px 2px rgba(11,11,11,.04),0 8px 24px rgba(11,11,11,.05);
--s0:#898781;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#a3a19a;--line:#2c2c2a;--axis:#383835;--accent:#3987e5;--good-ink:#3fc43f;--good-wash:#12260f;--ring:rgba(255,255,255,.10);--shadow:none;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--page);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans Arabic","Geeza Pro",Tahoma,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:920px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:clamp(28px,5vw,44px);line-height:1.12;margin:0 0 16px;letter-spacing:-.02em;text-wrap:balance}
h2{font-size:24px;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em}
h3{font-size:16px;margin:24px 0 8px}
p{margin:0 0 12px}
section{margin-top:56px}
.muted{color:var(--muted);font-size:14px}
.lead{color:var(--ink2);margin-bottom:20px}
.mini{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:20px 0 6px}
.pre{white-space:pre-wrap;overflow-wrap:anywhere}
.eyebrow{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:16px;padding:20px;box-shadow:var(--shadow)}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--page);border:1px solid var(--line);color:var(--ink2);white-space:nowrap}
.av{--c:var(--s0);display:inline-grid;place-items:center;flex:none;width:40px;height:40px;border-radius:50%;background:var(--c);color:#fff;font-size:14px;font-weight:700;letter-spacing:.02em}
.av.sm{width:24px;height:24px;font-size:10px}
.av.s4,.seat-in.s4{color:#0b0b0b;fill:#0b0b0b}
@media (prefers-color-scheme:dark){.av.s4,.seat-in.s4{color:#fff;fill:#fff}}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;padding-inline:4px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--ring);font-size:14px;font-weight:500}
.badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:600}
.badge svg{width:16px;height:16px}
.badge.ok{background:var(--good-wash);color:var(--good-ink)}
.hero{display:grid;grid-template-columns:1.25fr 1fr;gap:24px;align-items:center;padding:32px;border-radius:24px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 9%,var(--surface)),var(--surface) 60%);border:1px solid var(--ring);box-shadow:var(--shadow)}
.question{font-size:18px;color:var(--ink2);margin-bottom:16px;text-wrap:pretty}
.question span{display:block;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.hero-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:8px}
.council{width:100%;max-width:340px;display:block;margin:auto}
.council .table{fill:none;stroke:var(--line);stroke-width:1.5}
.council .table.inner{stroke-dasharray:3 6}
.council .beam{stroke-width:2;stroke-linecap:round;opacity:.55}
.council .hub{fill:var(--surface);stroke:var(--axis);stroke-width:1.5}
.council .hub.ok{fill:var(--good);stroke:none}
.council .tick{fill:none;stroke:#fff;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
.council .dot{fill:var(--muted)}
.seat-in{fill:#fff;font-size:16px;font-weight:700}
.seat-name{fill:var(--ink2);font-size:13px;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.kpi{background:var(--surface);border:1px solid var(--ring);border-radius:16px;padding:16px 18px}
.kpi-value{font-size:30px;font-weight:650;line-height:1.1;letter-spacing:-.02em}
.kpi-value.words{font-size:22px;line-height:1.5}
.kpi-label{color:var(--ink2);font-size:14px;margin-top:4px}
.decision{background:var(--surface);border:1px solid var(--ring);border-inline-start:6px solid var(--good);border-radius:16px;padding:8px 24px 24px;box-shadow:var(--shadow);margin-top:20px}
.resolution{font-size:clamp(19px,2.6vw,24px);line-height:1.35;font-weight:600;text-wrap:pretty;overflow-wrap:anywhere}
.summary{font-size:18px;color:var(--ink2);max-width:68ch}
.done{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.done li{display:flex;gap:10px;align-items:flex-start}
.done svg{flex:none;width:20px;height:20px;margin-top:3px;color:var(--good-ink)}
.highlights{list-style:none;margin:16px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.highlights li{display:flex;gap:14px;background:var(--surface);border:1px solid var(--ring);border-radius:16px;padding:16px}
.highlights p{margin:0;overflow-wrap:anywhere}
.num{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:color-mix(in srgb,var(--accent) 14%,var(--surface));color:var(--ink);font-weight:700;font-size:14px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;color:var(--ink2);margin-bottom:8px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.legend i{width:14px;height:3px;border-radius:2px;background:var(--c)}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart-title{font-size:14px;font-weight:600;color:var(--ink2);margin-bottom:14px}
.grid{stroke:var(--line);stroke-width:1}
.axis{stroke:var(--axis);stroke-width:1}
.tick-label{fill:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.end-label{fill:var(--ink);font-size:13px;font-weight:600}
.leader{stroke:var(--axis);stroke-width:1}
.ln{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pt{stroke:var(--surface);stroke-width:2;cursor:default;outline:none}
.pt:hover,.pt:focus-visible{stroke:var(--ink)}
.meters{display:grid;gap:14px}
.meter{display:grid;grid-template-columns:minmax(120px,1fr) 2fr auto;gap:14px;align-items:center}
.meter-name{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}
.meter-name span:last-child{flex-basis:100%;color:var(--ink2);font-size:13px;overflow-wrap:anywhere}
.meter-track{height:10px;border-radius:999px;background:color-mix(in srgb,var(--c) 18%,var(--surface));overflow:hidden}
.meter-fill{height:100%;width:var(--w);border-radius:999px;background:var(--c)}
.meter-value{font-weight:650;font-variant-numeric:tabular-nums;min-width:3.5ch;text-align:end}
.pos-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:12px}
.pos{background:var(--surface);border:1px solid var(--ring);border-radius:16px;padding:18px}
.pos header{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.pos h3{margin:0;font-size:17px}
.pos-round{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.pos-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-bottom:8px}
.quote{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink2);margin:0}
.evidence{margin:0;padding-inline-start:18px;color:var(--ink2);font-size:14px;overflow-wrap:anywhere}
.figures{display:grid;gap:16px}
figure{margin:0;background:var(--surface);border:1px solid var(--ring);border-radius:16px;padding:16px}
figure img{display:block;width:100%;height:auto;max-height:560px;object-fit:contain;background:#fff;border-radius:8px}
figcaption{margin-top:10px;font-size:14px;color:var(--ink2)}
.player{display:flex;flex-wrap:wrap;align-items:center;gap:10px;position:sticky;top:8px;z-index:2;background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(8px);border:1px solid var(--ring);border-radius:14px;padding:10px 12px;margin-bottom:16px}
.player[hidden]{display:none}
.btn{font:inherit;font-size:14px;font-weight:600;padding:7px 14px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
.btn.primary{background:var(--ink);color:var(--page);border-color:var(--ink)}
.btn:focus-visible,.more:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.progress{flex:1;min-width:80px;height:6px;border-radius:999px;background:var(--line);overflow:hidden}
.progress i{display:block;height:100%;width:0;background:var(--accent);border-radius:999px;transition:width .3s}
.timeline{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.tl-item{display:flex;gap:12px;align-items:flex-start}
.tl-card{flex:1;min-width:0;background:var(--surface);border:1px solid var(--ring);border-radius:4px 16px 16px 16px;padding:12px 16px}
[dir=rtl] .tl-card{border-radius:16px 4px 16px 16px}
.tl-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-bottom:6px}
.tl-body{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink2)}
.k-decision .tl-card{border-color:var(--good);background:var(--good-wash)}
.k-decision .tl-body{color:var(--ink)}
.more{font:inherit;font-size:13px;font-weight:600;color:var(--accent);background:none;border:0;padding:6px 0 0;cursor:pointer;display:none}
.conclusion{margin:0;padding:20px 24px;border-radius:16px;background:color-mix(in srgb,var(--accent) 8%,var(--surface));border:1px solid var(--ring);font-size:18px;text-wrap:pretty}
.steps{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--ring);border-radius:12px;overflow:hidden;font-size:15px}
.steps th{text-align:start;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--line)}
.steps td{padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.steps tr:last-child td{border-bottom:0}
.steps td:first-child{white-space:nowrap;font-weight:600}
.who{display:inline-flex;align-items:center;gap:8px}
.notes{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:10px}
.notes li{display:flex;gap:12px;background:var(--surface);border:1px solid var(--ring);border-radius:14px;padding:14px}
.notes li.dissent{border-inline-start:4px solid var(--ink2)}
.notes p{margin:6px 0 0;color:var(--ink2)}
footer{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);color:var(--ink2);font-size:14px}
#tip{position:fixed;z-index:9;pointer-events:none;background:var(--ink);color:var(--page);font-size:13px;padding:6px 10px;border-radius:8px;max-width:280px}
#tip[hidden]{display:none}
@media (max-width:720px){.hero{grid-template-columns:1fr;padding:22px}.hero-art{order:-1}.council{max-width:240px}.meter{grid-template-columns:1fr auto}.meter-track{grid-column:1/-1;order:3}section{margin-top:44px}}
@media (prefers-reduced-motion:no-preference){
.js .reveal{opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease;transition-delay:calc(var(--i,0)*70ms)}
.js .reveal.in{opacity:1;transform:none}
.js .tl-body.long{max-height:9.6em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 60%,transparent);mask-image:linear-gradient(#000 60%,transparent)}
.js .tl-body.long.open{max-height:none;-webkit-mask-image:none;mask-image:none}
.js .more{display:inline-block}
.js .seat{opacity:0;animation:pop .5s cubic-bezier(.2,1.4,.4,1) forwards;animation-delay:calc(.15s + var(--i)*.12s);transform-box:fill-box;transform-origin:center}
.js .beam{stroke-dasharray:140;stroke-dashoffset:140;animation:draw .7s ease forwards;animation-delay:calc(.7s + var(--i)*.12s)}
.js .hub{opacity:0;animation:pop .5s ease forwards 1.5s;transform-box:fill-box;transform-origin:center}
.js .tick{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .45s ease forwards 1.9s}
.js .dot{animation:blink 1.4s infinite both}.js .d2{animation-delay:.2s}.js .d3{animation-delay:.4s}
.js .ln{stroke-dasharray:1;stroke-dashoffset:1}
.js .in .ln{animation:draw 1.1s ease forwards;animation-delay:calc(.2s + var(--i)*.15s)}
.js .pt{opacity:0}.js .in .pt{animation:fade .4s ease forwards;animation-delay:calc(1s + var(--i)*.15s)}
.js .meter-fill{width:0;transition:width 1s cubic-bezier(.2,.8,.2,1) .2s}
.js .in .meter-fill{width:var(--w)}
.js .replaying .tl-item{display:none}
.js .replaying .tl-item.shown{display:flex;animation:rise .45s ease both}
}
@media (prefers-reduced-motion:reduce){.js .tl-body.long{max-height:9.6em;overflow:hidden}.js .tl-body.long.open{max-height:none}.js .more{display:inline-block}.js .replaying .tl-item{display:none}.js .replaying .tl-item.shown{display:flex}}
@keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fade{to{opacity:1}}
@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media print{.player,#tip{display:none!important}.js .reveal{opacity:1!important;transform:none!important}.js .tl-body.long{max-height:none!important;-webkit-mask-image:none!important;mask-image:none!important}.more{display:none!important}body{background:#fff}section{break-inside:avoid}}
`

// Plain ES5-style script kept free of backticks so it can sit inside the template above.
const SCRIPT = `
(function(){
var root=document.documentElement;root.classList.add('js');
var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function each(sel,fn){Array.prototype.forEach.call(document.querySelectorAll(sel),fn)}
each('time[datetime]',function(el){var d=new Date(el.getAttribute('datetime'));if(!isNaN(d)){el.title=el.textContent;el.textContent=d.toLocaleString(document.documentElement.lang,{dateStyle:'medium',timeStyle:'short'})}});
function count(el){var to=+el.getAttribute('data-count');if(reduce||!to){return}var start=performance.now();(function tick(now){var p=Math.min(1,(now-start)/900);el.textContent=Math.round(to*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(tick)})(start)}
if('IntersectionObserver' in window){var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');Array.prototype.forEach.call(e.target.querySelectorAll('[data-count]'),count);io.unobserve(e.target)}})},{threshold:.12});each('.reveal',function(el){io.observe(el)})}else{each('.reveal',function(el){el.classList.add('in')})}
each('.more',function(btn){btn.addEventListener('click',function(){var body=btn.previousElementSibling;var open=body.classList.toggle('open');btn.textContent=btn.getAttribute(open?'data-less':'data-more')})});
var tip=document.getElementById('tip');
function showTip(el){tip.textContent=el.getAttribute('data-tip');tip.hidden=false;var r=el.getBoundingClientRect();var w=tip.offsetWidth;var x=Math.max(8,Math.min(window.innerWidth-w-8,r.left+r.width/2-w/2));tip.style.left=x+'px';tip.style.top=Math.max(8,r.top-tip.offsetHeight-10)+'px'}
each('[data-tip]',function(el){el.addEventListener('mouseenter',function(){showTip(el)});el.addEventListener('focus',function(){showTip(el)});el.addEventListener('mouseleave',function(){tip.hidden=true});el.addEventListener('blur',function(){tip.hidden=true})});
var player=document.querySelector('.player'),list=document.querySelector('.timeline');
if(player&&list){var items=list.children,total=items.length,i=0,timer=null,playing=false,speed=1;
var play=document.getElementById('play'),all=document.getElementById('all'),spd=document.getElementById('speed'),bar=player.querySelector('.progress'),fill=bar.firstElementChild,cnt=document.getElementById('count');
if(total>1){player.hidden=false}
function progress(){fill.style.width=(total?i/total*100:0)+'%';bar.setAttribute('aria-valuenow',i);cnt.textContent=i+' / '+total}
function stop(){clearTimeout(timer);timer=null;playing=false}
function step(){if(i>=total){stop();play.textContent=play.getAttribute('data-play');return}var el=items[i];el.classList.add('shown');i++;progress();el.scrollIntoView({block:'center',behavior:reduce?'auto':'smooth'});var len=+el.getAttribute('data-len')||0;timer=setTimeout(step,Math.max(1400,Math.min(6500,1200+len*14))/speed)}
play.addEventListener('click',function(){if(playing){stop();play.textContent=play.getAttribute('data-resume');return}if(i>=total||!list.classList.contains('replaying')){i=0;Array.prototype.forEach.call(items,function(el){el.classList.remove('shown')});list.classList.add('replaying')}playing=true;play.textContent=play.getAttribute('data-pause');step()});
all.addEventListener('click',function(){stop();list.classList.remove('replaying');i=total;progress();play.textContent=play.getAttribute('data-play')});
spd.addEventListener('click',function(){speed=speed===1?2:speed===2?4:1;spd.textContent=speed+'\\u00d7'})}
})();
`
