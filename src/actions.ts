import { z } from 'zod'
import { type Room, RoomError } from './room.ts'
import type { Member } from './store.ts'

/**
 * Everything a participant can post to the room. Each action is defined once
 * and used three ways: as an MCP tool on the host, as an MCP tool on a
 * member's copy (which forwards it), and as the request a copy sends the host.
 */
export interface RoomAction {
  name: string
  title: string
  description: string
  schema: z.ZodObject
  /** Validates the input and applies the action to the room. Throws RoomError when a rule is broken. */
  run: (room: Room, member: Member, input: unknown, human?: boolean) => string
}

export const REPORT_BRIEF =
  'Write it for the humans on every side and be fair to each position. The app adds the timeline, every ' +
  "participant's own words and the charts; you supply title, summary, what_was_done, highlights, conclusion, " +
  'next_steps and, where a picture explains it better, one or two simple SVG diagrams (plain shapes and text, ' +
  'a viewBox, no scripts, no external images or fonts). If another participant already published the report, ' +
  'call sign_report instead.'

function define<S extends z.ZodObject>(action: {
  name: string
  title: string
  description: string
  schema: S
  run: (room: Room, member: Member, input: z.infer<S>, human: boolean) => string
}): RoomAction {
  return {
    ...action,
    run: (room, member, input, human = false) => {
      const parsed = action.schema.safeParse(input)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new RoomError(
          `Invalid ${action.name} input at ${issue?.path.join('.') || 'the top level'}: ${issue?.message ?? 'invalid'}`,
        )
      }
      return action.run(room, member, parsed.data, human)
    },
  }
}

const actionSchema = z.object({
  owner: z.string().min(1).max(60).describe('Who does it: a participant or a team'),
  action: z.string().min(3).max(300),
})

const reportPrompt = (room: Room, debateId: number): string =>
  room.store.settings().reports
    ? `\n\nNow publish the closing report: call submit_report with debate_id ${debateId}. ${REPORT_BRIEF}`
    : ''

export const ACTIONS: RoomAction[] = [
  define({
    name: 'send',
    title: 'Send a message',
    description:
      'Post a free-form message to everyone in the room. Use `reply_to` with a message number to answer a ' +
      'specific message. For a question the sides disagree on, prefer a debate.',
    schema: z.object({
      text: z.string().min(1).max(20000),
      reply_to: z.number().int().positive().optional(),
    }),
    run: (room, member, { text, reply_to }, human) =>
      `Sent as #${room.send(member, text, reply_to ?? null, human).seq}.`,
  }),

  define({
    name: 'open_debate',
    title: 'Open a debate',
    description:
      'Start a structured debate on one question the sides need to settle, for example which side of an ' +
      'integration should carry a fix. Give the options when they are known.',
    schema: z.object({
      question: z.string().min(5).max(400),
      options: z.array(z.string().min(1).max(120)).max(6).default([]),
      context: z
        .string()
        .max(20000)
        .default('')
        .describe('What a participant with no knowledge of your side needs to know'),
    }),
    run: (room, member, { question, options, context }) => {
      if (options.length === 1) throw new RoomError('Give at least two options, or none.')
      const { debate } = room.openDebate(member, { question, options, context })
      return (
        `Opened debate #${debate.id}. Post your own position with post_position, then wait_for_reply. ` +
        `Each participant has ${debate.maxRounds} positions.`
      )
    },
  }),

  define({
    name: 'post_position',
    title: 'Post a position',
    description:
      'State where you stand in a debate and why, with evidence from your own codebase (file paths, behaviour ' +
      'you verified, constraints). Post again in a later round when a peer changes your mind or you can answer them.',
    schema: z.object({
      debate_id: z.number().int().positive(),
      stance: z
        .string()
        .min(1)
        .max(160)
        .describe('One of the debate options when one fits, otherwise a short label'),
      reasoning: z.string().min(10).max(20000),
      evidence: z.array(z.string().min(3).max(1000)).max(8).default([]),
      confidence: z.number().int().min(0).max(100).describe('How sure you are, 0-100'),
    }),
    run: (room, member, { debate_id, stance, reasoning, evidence, confidence }) => {
      const result = room.postPosition(member, {
        debateId: debate_id,
        stance,
        reasoning,
        evidence,
        confidence,
      })
      const next =
        result.roundsLeft > 0
          ? `You have ${result.roundsLeft} position(s) left.`
          : 'That was your last position: next, propose a resolution, respond to one, or escalate.'
      return `Posted as #${result.event.seq} (round ${result.round}). ${next} Call wait_for_reply to hear the others.`
    },
  }),

  define({
    name: 'propose_resolution',
    title: 'Propose a resolution',
    description:
      'Propose how to settle a debate once the positions have converged or a compromise is clear. The other ' +
      'participants accept or reject it.',
    schema: z.object({
      debate_id: z.number().int().positive(),
      resolution: z.string().min(10).max(2000),
      rationale: z.string().min(10).max(4000),
      actions: z.array(actionSchema).max(10).default([]),
    }),
    run: (room, member, { debate_id, resolution, rationale, actions }) => {
      const event = room.propose(member, { debateId: debate_id, resolution, rationale, actions })
      return `Proposed as #${event.seq}. Call wait_for_reply to see whether the others accept.`
    },
  }),

  define({
    name: 'respond_to_resolution',
    title: 'Accept or reject a resolution',
    description:
      'Accept or reject a proposed resolution. Accept only if it is right for your side of the project; when ' +
      'you reject, say what would change your answer. The debate is decided once every other participant accepts.',
    schema: z.object({
      debate_id: z.number().int().positive(),
      proposal: z.number().int().positive().describe('The message number of the proposal'),
      verdict: z.enum(['accept', 'reject']),
      note: z.string().max(2000).default(''),
    }),
    run: (room, member, { debate_id, proposal, verdict, note }) => {
      const result = room.respond(member, { debateId: debate_id, proposal, verdict, note })
      if (!result.decision) {
        const waiting =
          result.waitingFor.length > 0 ? ` Still waiting for: ${result.waitingFor.join(', ')}.` : ''
        return `Recorded as #${result.event.seq}.${waiting}`
      }
      return (
        `Debate #${debate_id} is decided.\n\n${room.decisionRecord(debate_id)}\n\n` +
        `Offer to save this record in your user's repository.${reportPrompt(room, debate_id)}`
      )
    },
  }),

  define({
    name: 'escalate_debate',
    title: 'Escalate to the humans',
    description:
      'Stop a debate the agents cannot settle and hand it to the humans with a clear statement of the crux.',
    schema: z.object({
      debate_id: z.number().int().positive(),
      crux: z
        .string()
        .min(10)
        .max(2000)
        .describe('The one disagreement everything else depends on, stated fairly to both sides'),
      question: z.string().min(5).max(600).describe('What exactly the humans need to decide'),
    }),
    run: (room, member, { debate_id, crux, question }) => {
      const event = room.escalate(member, { debateId: debate_id, crux, question })
      return (
        `Escalated as #${event.seq}. Tell your user the crux and the question now. ` +
        'When they give you the outcome, call record_human_decision.'
      )
    },
  }),

  define({
    name: 'record_human_decision',
    title: 'Record the humans decision',
    description:
      'Record the outcome the humans chose for a debate. Call this only after your user has told you the decision.',
    schema: z.object({
      debate_id: z.number().int().positive(),
      decision: z.string().min(10).max(2000),
      rationale: z.string().min(5).max(4000),
      actions: z.array(actionSchema).max(10).default([]),
    }),
    run: (room, member, { debate_id, decision, rationale, actions }) => {
      room.recordHumanDecision(member, {
        debateId: debate_id,
        resolution: decision,
        rationale,
        actions,
      })
      return `Debate #${debate_id} is decided.\n\n${room.decisionRecord(debate_id)}${reportPrompt(room, debate_id)}`
    },
  }),

  define({
    name: 'submit_report',
    title: 'Publish the closing report',
    description: `Publish the illustrated report of a decided debate, or of the whole conversation since the last report when \`debate_id\` is omitted. ${REPORT_BRIEF}`,
    schema: z.object({
      debate_id: z.number().int().positive().optional(),
      title: z.string().min(3).max(120),
      summary: z.string().min(20).max(1500).describe('Two to four sentences a newcomer can follow'),
      what_was_done: z.array(z.string().min(3).max(300)).max(10).default([]),
      highlights: z.array(z.string().min(3).max(300)).min(1).max(8),
      conclusion: z.string().min(10).max(1500),
      next_steps: z.array(actionSchema).max(10).default([]),
      diagrams: z
        .array(
          z.object({
            title: z.string().min(1).max(100),
            caption: z.string().max(300).default(''),
            svg: z.string().min(20).max(30000).describe('A complete <svg> element with a viewBox'),
          }),
        )
        .max(4)
        .default([]),
      language: z
        .enum(['en', 'ar'])
        .default('en')
        .describe('Language the report text is written in'),
    }),
    run: (room, member, { debate_id, ...content }) => {
      for (const diagram of content.diagrams) {
        const svg = diagram.svg.trim()
        if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
          throw new RoomError(
            `Diagram "${diagram.title}" must be one complete <svg>...</svg> element.`,
          )
        }
      }
      const { report, url } = room.submitReport(member, debate_id ?? null, content)
      return `Report ${report.id} is published: ${url}\nGive your user this link. The address is valid while the host's room is running.`
    },
  }),

  define({
    name: 'sign_report',
    title: 'Sign off or dissent',
    description:
      "Add your side's note to a published report: a sign-off if it is fair, or a dissenting note if it misstates your position.",
    schema: z.object({
      report_id: z.number().int().positive(),
      kind: z.enum(['signoff', 'dissent']),
      note: z.string().min(2).max(1000),
    }),
    run: (room, member, { report_id, kind, note }) => {
      const report = room.signReport(member, report_id, kind, note)
      return `Your ${kind === 'signoff' ? 'sign-off' : 'dissent'} is on report ${report.id}: ${room.reportUrl(report)}`
    },
  }),
]

export const ACTIONS_BY_NAME = new Map(ACTIONS.map((action) => [action.name, action]))
