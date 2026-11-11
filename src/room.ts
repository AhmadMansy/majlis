import type {
  Action,
  Contract,
  Debate,
  Decision,
  Member,
  ReportNote,
  RoomEvent,
  RoomStore,
  StoredReport,
} from './store.ts'

/** A rule of the room was broken; the message is safe to show to the agent or the host. */
export class RoomError extends Error {}

export interface PositionView {
  seq: number
  member: string
  round: number
  stance: string
  reasoning: string
  evidence: string[]
  confidence: number
  ts: string
}

export interface ResponseView {
  seq: number
  member: string
  verdict: 'accept' | 'reject'
  note: string
}

export interface ProposalView {
  seq: number
  member: string
  resolution: string
  rationale: string
  actions: Action[]
  /** The latest response of each member. */
  responses: ResponseView[]
  ts: string
}

export interface DebateView {
  debate: Debate
  openedByName: string
  positions: PositionView[]
  proposals: ProposalView[]
  escalation: { member: string; crux: string; question: string; ts: string } | null
  /** Names of everyone who posted a position, proposal or response. */
  participants: string[]
  roundsUsed: Record<string, number>
}

export interface ReportContent {
  title: string
  summary: string
  what_was_done: string[]
  highlights: string[]
  conclusion: string
  next_steps: Action[]
  diagrams: Array<{ title: string; caption: string; svg: string }>
  language: 'en' | 'ar'
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const actionsOf = (value: unknown): Action[] =>
  Array.isArray(value)
    ? value
        .filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
        .map((item) => ({ owner: str(item.owner), action: str(item.action) }))
    : []

function actionLines(actions: Action[]): string {
  return actions.length === 0
    ? ''
    : `\nActions:\n${actions.map((a) => `- ${a.owner}: ${a.action}`).join('\n')}`
}

const KIND_LABEL: Record<RoomEvent['kind'], string> = {
  message: '',
  debate_opened: 'opened a debate',
  position: 'position',
  proposal: 'proposed resolution',
  response: 'response',
  escalation: 'escalated to the humans',
  decision: 'DECISION',
  report: 'report',
  profile: 'described their side',
  contract: 'pinned contract',
}

/** One event as an agent reads it. */
export function formatEvent(event: RoomEvent): string {
  const parts = [`[#${event.seq}] ${event.authorName}`, event.ts]
  if (event.data.via === 'human') parts.push('typed by the human')
  if (KIND_LABEL[event.kind]) parts.push(KIND_LABEL[event.kind])
  if (event.debateId !== null) parts.push(`debate #${event.debateId}`)
  if (event.replyTo !== null) parts.push(`reply to #${event.replyTo}`)
  return `${parts.join(' · ')}\n${event.body}`
}

/**
 * The rules of the room. MCP tools and the host's control panel both go
 * through here, so limits and the debate protocol apply to every way in.
 */
export class Room {
  readonly store: RoomStore
  readonly name: string
  /** Where the room can be reached; `public` is set once a tunnel is up. */
  urls: { local: string; public: string | null } = { local: '', public: null }

  constructor(store: RoomStore, name: string) {
    this.store = store
    this.name = name
  }

  // ── Guards ─────────────────────────────────────────────────────────────

  #guardWrite(member: Member, human: boolean): void {
    if (human) return
    const settings = this.store.settings()
    if (settings.paused) {
      throw new RoomError('The host has paused the room. Nothing can be posted until it resumes.')
    }
    if (member.role === 'observer') {
      throw new RoomError('You are an observer in this room: you can read but not post.')
    }
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    if (this.store.postsSince(member.id, hourAgo) >= settings.postsPerHour) {
      throw new RoomError(
        `You reached the room limit of ${settings.postsPerHour} posts per hour. Stop posting and tell your user.`,
      )
    }
  }

  #guardLength(label: string, value: string): void {
    const max = this.store.settings().maxMessageChars
    if (value.length > max) {
      throw new RoomError(`${label} is ${value.length} characters; this room allows ${max}.`)
    }
  }

  #openDebate(debateId: number): Debate {
    if (!this.store.settings().debates) throw new RoomError('Debates are turned off in this room.')
    const debate = this.store.debate(debateId)
    if (!debate) throw new RoomError(`There is no debate #${debateId} in this room.`)
    if (debate.status !== 'open') {
      throw new RoomError(`Debate #${debateId} is ${debate.status}; it no longer accepts this.`)
    }
    return debate
  }

  // ── Messages ───────────────────────────────────────────────────────────

  send(member: Member, text: string, replyTo: number | null, human = false): RoomEvent {
    this.#guardWrite(member, human)
    this.#guardLength('The message', text)
    if (replyTo !== null && !this.store.event(replyTo)) {
      throw new RoomError(`There is no message #${replyTo} in this room.`)
    }
    return this.store.append({
      authorId: member.id,
      kind: 'message',
      body: text,
      replyTo,
      data: human ? { via: 'human' } : {},
    })
  }

  // ── Debates ────────────────────────────────────────────────────────────

  openDebate(
    member: Member,
    input: { question: string; options: string[]; context: string },
  ): { debate: Debate; event: RoomEvent } {
    this.#guardWrite(member, false)
    const settings = this.store.settings()
    if (!settings.debates) throw new RoomError('Debates are turned off in this room.')
    this.#guardLength('The context', input.context)
    const debate = this.store.createDebate({
      question: input.question,
      options: input.options,
      context: input.context,
      openedBy: member.id,
      maxRounds: settings.maxRounds,
    })
    const body = [
      `Question: ${debate.question}`,
      debate.options.length > 0 ? `Options: ${debate.options.join(' | ')}` : '',
      debate.context ? `Context: ${debate.context}` : '',
      `Each participant may post up to ${debate.maxRounds} positions.`,
    ]
      .filter(Boolean)
      .join('\n')
    const event = this.store.append({
      authorId: member.id,
      kind: 'debate_opened',
      body,
      debateId: debate.id,
    })
    return { debate, event }
  }

  postPosition(
    member: Member,
    input: {
      debateId: number
      stance: string
      reasoning: string
      evidence: string[]
      confidence: number
    },
  ): { event: RoomEvent; round: number; roundsLeft: number } {
    this.#guardWrite(member, false)
    const debate = this.#openDebate(input.debateId)
    this.#guardLength('The reasoning', input.reasoning)
    const used = this.debateView(debate.id).roundsUsed[member.name] ?? 0
    if (used >= debate.maxRounds) {
      throw new RoomError(
        `You have used all ${debate.maxRounds} positions in debate #${debate.id}. ` +
          'Propose a resolution, respond to one, or escalate to the humans.',
      )
    }
    const round = used + 1
    const evidence =
      input.evidence.length > 0
        ? `\nEvidence:\n${input.evidence.map((e) => `- ${e}`).join('\n')}`
        : ''
    const event = this.store.append({
      authorId: member.id,
      kind: 'position',
      debateId: debate.id,
      body: `Round ${round} · Stance: ${input.stance} · Confidence: ${input.confidence}%\n${input.reasoning}${evidence}`,
      data: {
        round,
        stance: input.stance,
        reasoning: input.reasoning,
        evidence: input.evidence,
        confidence: input.confidence,
      },
    })
    return { event, round, roundsLeft: debate.maxRounds - round }
  }

  propose(
    member: Member,
    input: { debateId: number; resolution: string; rationale: string; actions: Action[] },
  ): RoomEvent {
    this.#guardWrite(member, false)
    const debate = this.#openDebate(input.debateId)
    this.#guardLength('The resolution', input.resolution + input.rationale)
    return this.store.append({
      authorId: member.id,
      kind: 'proposal',
      debateId: debate.id,
      body: `Resolution: ${input.resolution}\nRationale: ${input.rationale}${actionLines(input.actions)}`,
      data: { resolution: input.resolution, rationale: input.rationale, actions: input.actions },
    })
  }

  /** Records a response and, when every other participant has accepted, closes the debate. */
  respond(
    member: Member,
    input: { debateId: number; proposal: number; verdict: 'accept' | 'reject'; note: string },
  ): { event: RoomEvent; decision: Decision | null; waitingFor: string[] } {
    this.#guardWrite(member, false)
    const debate = this.#openDebate(input.debateId)
    const proposal = this.store.event(input.proposal)
    if (proposal?.kind !== 'proposal' || proposal.debateId !== debate.id) {
      throw new RoomError(
        `#${input.proposal} is not a proposed resolution in debate #${debate.id}.`,
      )
    }
    if (proposal.authorId === member.id) {
      throw new RoomError('You proposed this resolution; the other participants respond to it.')
    }
    const event = this.store.append({
      authorId: member.id,
      kind: 'response',
      debateId: debate.id,
      replyTo: proposal.seq,
      body: `${input.verdict === 'accept' ? 'Accepts' : 'Rejects'} proposal #${proposal.seq}${input.note ? `: ${input.note}` : '.'}`,
      data: { proposal: proposal.seq, verdict: input.verdict, note: input.note },
    })

    const view = this.debateView(debate.id)
    const active = new Set(
      this.store
        .members()
        .filter((m) => m.role !== 'observer')
        .map((m) => m.name),
    )
    const required = view.participants.filter(
      (name) => name !== proposal.authorName && active.has(name),
    )
    const responses = view.proposals.find((p) => p.seq === proposal.seq)?.responses ?? []
    const accepted = new Set(responses.filter((r) => r.verdict === 'accept').map((r) => r.member))
    const waitingFor = required.filter((name) => !accepted.has(name))
    if (required.length === 0 || waitingFor.length > 0) {
      return { event, decision: null, waitingFor }
    }

    const decision: Decision = {
      resolution: str(proposal.data.resolution),
      rationale: str(proposal.data.rationale),
      actions: actionsOf(proposal.data.actions),
      decidedBy: 'agreement',
      acceptedBy: [proposal.authorName, ...required],
      recordedBy: member.name,
      ts: new Date().toISOString(),
    }
    this.#decide(member, debate, decision, false)
    return { event, decision, waitingFor: [] }
  }

  escalate(member: Member, input: { debateId: number; crux: string; question: string }): RoomEvent {
    this.#guardWrite(member, false)
    const debate = this.#openDebate(input.debateId)
    const event = this.store.append({
      authorId: member.id,
      kind: 'escalation',
      debateId: debate.id,
      body: `The agents could not agree.\nCrux: ${input.crux}\nThe humans must decide: ${input.question}`,
      data: { crux: input.crux, question: input.question },
    })
    this.store.setDebateStatus(debate.id, 'escalated')
    return event
  }

  /** Records a decision made by the humans, for an open or escalated debate. */
  recordHumanDecision(
    member: Member,
    input: { debateId: number; resolution: string; rationale: string; actions: Action[] },
    human = false,
  ): Decision {
    this.#guardWrite(member, human)
    const debate = this.store.debate(input.debateId)
    if (!debate) throw new RoomError(`There is no debate #${input.debateId} in this room.`)
    if (debate.status === 'decided') {
      throw new RoomError(`Debate #${debate.id} already has a decision.`)
    }
    const decision: Decision = {
      resolution: input.resolution,
      rationale: input.rationale,
      actions: input.actions,
      decidedBy: 'humans',
      acceptedBy: [],
      recordedBy: member.name,
      ts: new Date().toISOString(),
    }
    this.#decide(member, debate, decision, human)
    return decision
  }

  #decide(member: Member, debate: Debate, decision: Decision, human: boolean): void {
    const how =
      decision.decidedBy === 'agreement'
        ? `Decided by agreement of ${decision.acceptedBy.join(', ')}.`
        : 'Decided by the humans.'
    this.store.append({
      authorId: member.id,
      kind: 'decision',
      debateId: debate.id,
      body: `${how}\nDecision: ${decision.resolution}\nRationale: ${decision.rationale}${actionLines(decision.actions)}`,
      data: { ...decision, ...(human ? { via: 'human' } : {}) },
    })
    this.store.setDebateStatus(debate.id, 'decided', decision)
  }

  debateView(debateId: number): DebateView {
    const debate = this.store.debate(debateId)
    if (!debate) throw new RoomError(`There is no debate #${debateId} in this room.`)
    const positions: PositionView[] = []
    const proposals: ProposalView[] = []
    const participants: string[] = []
    const roundsUsed: Record<string, number> = {}
    let escalation: DebateView['escalation'] = null
    const join = (name: string) => {
      if (!participants.includes(name)) participants.push(name)
    }

    for (const event of this.store.debateEvents(debateId)) {
      if (event.kind === 'position') {
        join(event.authorName)
        roundsUsed[event.authorName] = (roundsUsed[event.authorName] ?? 0) + 1
        positions.push({
          seq: event.seq,
          member: event.authorName,
          round: Number(event.data.round ?? roundsUsed[event.authorName]),
          stance: str(event.data.stance),
          reasoning: str(event.data.reasoning),
          evidence: list(event.data.evidence),
          confidence: Number(event.data.confidence ?? 0),
          ts: event.ts,
        })
      } else if (event.kind === 'proposal') {
        join(event.authorName)
        proposals.push({
          seq: event.seq,
          member: event.authorName,
          resolution: str(event.data.resolution),
          rationale: str(event.data.rationale),
          actions: actionsOf(event.data.actions),
          responses: [],
          ts: event.ts,
        })
      } else if (event.kind === 'response') {
        join(event.authorName)
        const proposal = proposals.find((p) => p.seq === Number(event.data.proposal))
        if (proposal) {
          proposal.responses = proposal.responses.filter((r) => r.member !== event.authorName)
          proposal.responses.push({
            seq: event.seq,
            member: event.authorName,
            verdict: event.data.verdict === 'accept' ? 'accept' : 'reject',
            note: str(event.data.note),
          })
        }
      } else if (event.kind === 'escalation') {
        escalation = {
          member: event.authorName,
          crux: str(event.data.crux),
          question: str(event.data.question),
          ts: event.ts,
        }
      }
    }
    return {
      debate,
      openedByName: this.store.memberName(debate.openedBy),
      positions,
      proposals,
      escalation,
      participants,
      roundsUsed,
    }
  }

  /** A debate as an agent reads it: where it stands and what can happen next. */
  describeDebate(debateId: number, forMember?: Member): string {
    const view = this.debateView(debateId)
    const { debate } = view
    const lines = [
      `Debate #${debate.id} · ${debate.status.toUpperCase()} · opened by ${view.openedByName}`,
      `Question: ${debate.question}`,
    ]
    if (debate.options.length > 0) lines.push(`Options: ${debate.options.join(' | ')}`)
    if (debate.context) lines.push(`Context: ${debate.context}`)

    if (view.positions.length > 0) {
      lines.push('', 'Latest position of each participant:')
      for (const name of view.participants) {
        const latest = view.positions.filter((p) => p.member === name).at(-1)
        if (latest) {
          lines.push(
            `- ${name} (round ${latest.round}/${debate.maxRounds}): ${latest.stance} · ${latest.confidence}% — see #${latest.seq}`,
          )
        }
      }
    }
    for (const proposal of view.proposals) {
      const responses =
        proposal.responses.map((r) => `${r.member} ${r.verdict}s`).join(', ') || 'no responses yet'
      lines.push('', `Proposal #${proposal.seq} by ${proposal.member}: ${proposal.resolution}`)
      lines.push(`  Responses: ${responses}`)
    }
    if (view.escalation) {
      lines.push('', `Escalated by ${view.escalation.member}. Crux: ${view.escalation.crux}`)
      lines.push(`The humans must decide: ${view.escalation.question}`)
    }
    if (debate.decision) {
      lines.push('', '--- Decision record (Markdown) ---', this.decisionRecord(debateId))
      const report = this.store.reportForDebate(debateId)
      lines.push(
        '',
        report ? `Report: ${this.reportUrl(report)}` : 'No report has been published yet.',
      )
    } else if (forMember && debate.status === 'open') {
      const left = debate.maxRounds - (view.roundsUsed[forMember.name] ?? 0)
      lines.push('', `You have ${left} position(s) left in this debate.`)
    }
    return lines.join('\n')
  }

  /** The decision as a Markdown record a team can keep in its repository. */
  decisionRecord(debateId: number): string {
    const view = this.debateView(debateId)
    const { debate } = view
    const decision = debate.decision
    if (!decision) throw new RoomError(`Debate #${debateId} has no decision yet.`)
    const how =
      decision.decidedBy === 'agreement'
        ? `By agreement of ${decision.acceptedBy.join(', ')}`
        : `By the humans, recorded by ${decision.recordedBy}`
    const lines = [
      `# Decision: ${debate.question}`,
      '',
      `- Room: ${this.name} · Debate #${debate.id}`,
      `- Decided: ${decision.ts.slice(0, 10)}`,
      `- How: ${how}`,
      '',
      '## Decision',
      '',
      decision.resolution,
      '',
      '## Rationale',
      '',
      decision.rationale,
    ]
    if (decision.actions.length > 0) {
      lines.push(
        '',
        '## Actions',
        '',
        ...decision.actions.map((a) => `- **${a.owner}**: ${a.action}`),
      )
    }
    if (view.positions.length > 0) {
      lines.push('', '## Final positions', '')
      for (const name of view.participants) {
        const latest = view.positions.filter((p) => p.member === name).at(-1)
        if (latest) {
          lines.push(
            `- **${name}**: ${latest.stance} (${latest.confidence}% confident). ${latest.reasoning}`,
          )
        }
      }
    }
    if (view.escalation) {
      lines.push('', '## Why it went to the humans', '', view.escalation.crux)
    }
    const dissent = (this.store.reportForDebate(debateId)?.notes ?? []).filter(
      (note) => note.kind === 'dissent',
    )
    if (dissent.length > 0) {
      lines.push('', '## Dissent', '', ...dissent.map((n) => `- **${n.member}**: ${n.note}`))
    }
    return lines.join('\n')
  }

  // ── Profiles and pinned contracts ──────────────────────────────────────

  /** Records what a member's agent says its side owns, and tells the others once. */
  setProfile(member: Member, profile: string): RoomEvent {
    this.#guardWrite(member, false)
    this.#guardLength('The profile', profile)
    this.store.setProfile(member.id, profile)
    return this.store.append({ authorId: member.id, kind: 'profile', body: profile })
  }

  /** Pins or replaces a shared definition. Every change is announced, so no side builds on a stale one. */
  pinContract(
    member: Member,
    input: { name: string; content: string; note: string },
  ): { contract: Contract; event: RoomEvent } {
    this.#guardWrite(member, false)
    this.#guardLength('The contract', input.content)
    const before = this.store.contract(input.name)
    const contract = this.store.pinContract({ ...input, updatedBy: member.name })
    const event = this.store.append({
      authorId: member.id,
      kind: 'contract',
      body:
        `${before ? 'Changed' : 'Pinned'} "${contract.name}" (version ${contract.version})` +
        `${input.note ? `: ${input.note}` : '.'}\nRead it with the contracts tool before relying on it.`,
      data: { name: contract.name, version: contract.version },
    })
    return { contract, event }
  }

  /** The pinned contracts as an agent reads them: the list, or one in full. */
  describeContracts(name?: string): string {
    if (name !== undefined) {
      const contract = this.store.contract(name)
      if (!contract) throw new RoomError(`There is no pinned contract named "${name}".`)
      return (
        `Contract "${contract.name}" · version ${contract.version} · last changed by ${contract.updatedBy} ` +
        `on ${contract.updatedAt}${contract.note ? `\nNote: ${contract.note}` : ''}\n\n${contract.content}`
      )
    }
    const contracts = this.store.contracts()
    if (contracts.length === 0) return 'Nothing is pinned in this room yet.'
    return contracts
      .map(
        (c) =>
          `- ${c.name} · version ${c.version} · ${c.updatedBy}, ${c.updatedAt.slice(0, 10)}${c.note ? ` · ${c.note}` : ''}`,
      )
      .join('\n')
  }

  // ── Reports ────────────────────────────────────────────────────────────

  submitReport(
    member: Member,
    debateId: number | null,
    content: ReportContent,
  ): { report: StoredReport; url: string } {
    this.#guardWrite(member, false)
    if (!this.store.settings().reports) throw new RoomError('Reports are turned off in this room.')

    let fromSeq: number
    let toSeq: number
    if (debateId === null) {
      fromSeq = this.store.lastRoomReportSeq()
      toSeq = this.store.lastSeq()
      const fresh = this.store.eventsBetween(fromSeq, toSeq).filter((e) => e.kind !== 'report')
      if (fresh.length === 0) {
        throw new RoomError(
          'Nothing has been said since the last report, so there is nothing to report.',
        )
      }
    } else {
      const debate = this.store.debate(debateId)
      if (!debate) throw new RoomError(`There is no debate #${debateId} in this room.`)
      if (debate.status !== 'decided') {
        throw new RoomError(
          `Debate #${debateId} is still ${debate.status}; report it once it is decided.`,
        )
      }
      const events = this.store.debateEvents(debateId)
      fromSeq = (events[0]?.seq ?? 1) - 1
      toSeq = events.at(-1)?.seq ?? fromSeq
    }

    const report = this.store.saveReport({
      debateId,
      author: member.name,
      content: { ...content },
      fromSeq,
      toSeq,
    })
    const url = this.reportUrl(report)
    this.store.append({
      authorId: member.id,
      kind: 'report',
      debateId,
      body: `Published the report "${content.title}": ${url}\nOther participants can add a sign-off or a dissenting note with sign_report (report ${report.id}).`,
      data: { reportId: report.id },
    })
    return { report, url }
  }

  signReport(
    member: Member,
    reportId: number,
    kind: ReportNote['kind'],
    note: string,
  ): StoredReport {
    this.#guardWrite(member, false)
    const report = this.store.report(reportId)
    if (!report) throw new RoomError(`There is no report ${reportId} in this room.`)
    const notes = report.notes.filter((existing) => existing.member !== member.name)
    notes.push({ member: member.name, kind, note, ts: new Date().toISOString() })
    this.store.setReportNotes(report.id, notes)
    return this.store.report(report.id) as StoredReport
  }

  reportUrl(report: StoredReport): string {
    return `${this.urls.public ?? this.urls.local}/r/${report.key}`
  }
}
