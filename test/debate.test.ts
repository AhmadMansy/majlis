import { afterEach, describe, expect, it } from 'vitest'
import { type Agent, openTestRoom, type TestRoom } from './helpers.ts'

let t: TestRoom

afterEach(async () => {
  await t.close()
})

const QUESTION = 'Should the resume crash be fixed in the Unity plugin or the Android activity?'

/** Ahmed opens the debate, both sides post once, Ahmed proposes. Returns the proposal number. */
async function debateUntilProposal(ahmed: Agent, omar: Agent): Promise<number> {
  await ahmed.call('open_debate', { question: QUESTION, options: ['Unity', 'Android'] })
  await ahmed.call('post_position', {
    debate_id: 1,
    stance: 'Android',
    reasoning: 'The surface is destroyed before Unity gets the pause callback.',
    evidence: ['UnityPlayerActivity.onPause runs after surfaceDestroyed on API 34'],
    confidence: 60,
  })
  await omar.call('post_position', {
    debate_id: 1,
    stance: 'Android',
    reasoning: 'Agreed, the activity must hold the surface until Unity has paused.',
    confidence: 85,
  })
  const proposed = await ahmed.call('propose_resolution', {
    debate_id: 1,
    resolution: 'Fix it in the Android activity by deferring surface teardown.',
    rationale: 'Both sides traced the crash to the activity lifecycle order.',
    actions: [{ owner: 'Omar', action: 'Patch onPause ordering' }],
  })
  return Number(/#(\d+)/.exec(proposed)?.[1])
}

const REPORT = {
  title: 'Resume crash: fix goes to Android',
  summary:
    'Both agents traced the crash to the activity lifecycle and agreed on an Android-side fix.',
  what_was_done: ['Compared lifecycle order on both sides'],
  highlights: ['The surface is destroyed before Unity pauses'],
  conclusion: 'The Android activity will defer surface teardown.',
  next_steps: [{ owner: 'Omar', action: 'Patch onPause ordering' }],
}

describe('debate', () => {
  it('is decided once the other participant accepts the proposal', async () => {
    t = await openTestRoom()
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')
    const proposal = await debateUntilProposal(ahmed, omar)

    expect(
      await ahmed.fails('respond_to_resolution', { debate_id: 1, proposal, verdict: 'accept' }),
    ).toContain('You proposed')

    const accepted = await omar.call('respond_to_resolution', {
      debate_id: 1,
      proposal,
      verdict: 'accept',
    })
    expect(accepted).toContain('Debate #1 is decided')
    expect(accepted).toContain('# Decision: Should the resume crash')
    expect(accepted).toContain('By agreement of Ahmed, Omar')
    expect(accepted).toContain('**Omar**: Patch onPause ordering')
    expect(accepted).toContain('submit_report')

    expect(t.store.debate(1)?.status).toBe('decided')
    expect(await ahmed.call('inbox')).toContain('DECISION')
    expect(
      await omar.fails('post_position', {
        debate_id: 1,
        stance: 'x',
        reasoning: 'too late now',
        confidence: 1,
      }),
    ).toContain('decided')
  })

  it('waits for every participant, and a rejection keeps it open', async () => {
    t = await openTestRoom(['Omar', 'Sara'])
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')
    const sara = await t.agent('Sara')
    const proposal = await debateUntilProposal(ahmed, omar)
    await sara.call('post_position', {
      debate_id: 1,
      stance: 'Unity',
      reasoning: 'The design needs the pause overlay drawn by Unity first.',
      confidence: 40,
    })

    const first = await omar.call('respond_to_resolution', {
      debate_id: 1,
      proposal,
      verdict: 'accept',
    })
    expect(first).toContain('Still waiting for: Sara')
    const rejected = await sara.call('respond_to_resolution', {
      debate_id: 1,
      proposal,
      verdict: 'reject',
      note: 'Only if the overlay still shows.',
    })
    expect(rejected).toContain('Still waiting for: Sara')
    expect(t.store.debate(1)?.status).toBe('open')

    const changed = await sara.call('respond_to_resolution', {
      debate_id: 1,
      proposal,
      verdict: 'accept',
    })
    expect(changed).toContain('By agreement of Ahmed, Omar, Sara')
  })

  it('limits how many positions each participant may post', async () => {
    t = await openTestRoom()
    t.store.updateSettings({ maxRounds: 1 })
    const ahmed = await t.agent('Ahmed')
    await ahmed.call('open_debate', { question: QUESTION })
    const position = {
      debate_id: 1,
      stance: 'Android',
      reasoning: 'Lifecycle order is wrong.',
      confidence: 50,
    }
    expect(await ahmed.call('post_position', position)).toContain('last position')
    expect(await ahmed.fails('post_position', position)).toContain('used all 1 positions')
  })

  it('can be escalated and then settled by the humans', async () => {
    t = await openTestRoom()
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')
    await ahmed.call('open_debate', { question: QUESTION })
    await omar.call('escalate_debate', {
      debate_id: 1,
      crux: 'Whether the plugin may assume the activity keeps the surface alive.',
      question: 'Which team owns surface lifetime?',
    })
    expect(t.store.debate(1)?.status).toBe('escalated')
    expect(await ahmed.call('debate_status', { debate_id: 1 })).toContain('The humans must decide')

    const decided = await ahmed.call('record_human_decision', {
      debate_id: 1,
      decision: 'Android owns surface lifetime.',
      rationale: 'Agreed on the call.',
    })
    expect(decided).toContain('By the humans, recorded by Ahmed')
    expect(decided).toContain('## Why it went to the humans')
  })

  it('refuses debates when the host turned them off', async () => {
    t = await openTestRoom()
    t.store.updateSettings({ debates: false })
    const ahmed = await t.agent('Ahmed')
    expect(await ahmed.fails('open_debate', { question: QUESTION })).toContain('turned off')
  })
})

describe('report', () => {
  it('is only accepted for a decided debate', async () => {
    t = await openTestRoom()
    const ahmed = await t.agent('Ahmed')
    await ahmed.call('open_debate', { question: QUESTION })
    expect(await ahmed.fails('submit_report', { debate_id: 1, ...REPORT })).toContain('still open')
  })

  it('is served as a self-contained page with agent content made inert', async () => {
    t = await openTestRoom()
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')
    const proposal = await debateUntilProposal(ahmed, omar)
    await omar.call('respond_to_resolution', { debate_id: 1, proposal, verdict: 'accept' })

    const published = await omar.call('submit_report', {
      debate_id: 1,
      ...REPORT,
      title: 'Fix goes to <script>alert(1)</script> Android',
      diagrams: [
        {
          title: 'Lifecycle',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(2)</script><rect width="10" height="10"/></svg>',
        },
      ],
    })
    const url = /http:\/\/\S+\/r\/[A-Za-z0-9_-]+/.exec(published)?.[0] ?? ''
    expect(url).not.toBe('')

    await ahmed.call('sign_report', {
      report_id: 1,
      kind: 'dissent',
      note: 'The Unity overlay risk is understated.',
    })

    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await response.text()

    expect(html).toContain('Fix goes to &lt;script&gt;alert(1)&lt;/script&gt; Android')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('src="data:image/svg+xml;base64,')
    expect(html).toContain('Decided by agreement')
    expect(html).toContain('The surface is destroyed before Unity gets the pause callback.')
    expect(html).toContain('The Unity overlay risk is understated.')
    expect(html).not.toMatch(/(src|href)="https?:/)

    expect(await ahmed.call('debate_status', { debate_id: 1 })).toContain('## Dissent')
    expect((await fetch(url.replace(/.{4}$/, 'AAAA'))).status).toBe(404)
  })

  it('can cover the plain conversation since the last report', async () => {
    t = await openTestRoom()
    const ahmed = await t.agent('Ahmed')
    const omar = await t.agent('Omar')
    await ahmed.call('send', { text: 'Which payload format does the push handler expect?' })
    await omar.call('send', { text: 'JSON with a data block, no notification block.' })

    const published = await ahmed.call('submit_report', {
      ...REPORT,
      title: 'Push payload agreed',
      language: 'ar',
    })
    const url = /http:\/\/\S+\/r\/[A-Za-z0-9_-]+/.exec(published)?.[0] ?? ''
    const html = await (await fetch(url)).text()
    expect(html).toContain('<html lang="ar" dir="rtl">')
    expect(html).toContain('JSON with a data block, no notification block.')
    expect(html).not.toContain('Decided by')

    expect(await ahmed.fails('submit_report', REPORT)).toContain('Nothing has been said')
  })
})
