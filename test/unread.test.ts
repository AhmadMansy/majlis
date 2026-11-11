import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hookOutput, hookSettings, unreadNotice, writeHookSettings } from '../src/unread.ts'
import { openTestCopy, openTestRoom, type TestCopy, type TestRoom } from './helpers.ts'

let host: TestRoom
let copy: TestCopy | undefined

beforeEach(async () => {
  host = await openTestRoom()
})

afterEach(async () => {
  await copy?.close()
  copy = undefined
  await host.close()
})

describe('unread notice', () => {
  it('says who posted and what kind of post, never the content', async () => {
    expect(unreadNotice(host.store, false)).toBe('')

    const omar = await host.agent('Omar')
    await omar.call('send', { text: 'The token is in the payload under data.secretField.' })
    await omar.call('open_debate', { question: 'Which side should parse the payload?' })

    const notice = unreadNotice(host.store, false)
    expect(notice).toContain('2 unread posts in the shared room from Omar')
    expect(notice).toContain('including a new debate')
    expect(notice).toContain('inbox')
    expect(notice).not.toContain('secretField')
    expect(notice).not.toContain('parse the payload')
  })

  it('tells a running session once per new post, and a new session every time', async () => {
    const omar = await host.agent('Omar')
    await omar.call('send', { text: 'First.' })

    expect(hookOutput(host.store, 'UserPromptSubmit')).toContain('1 unread post in')
    expect(hookOutput(host.store, 'UserPromptSubmit')).toBe('')
    expect(hookOutput(host.store, 'PostToolUse')).toBe('')
    expect(hookOutput(host.store, 'SessionStart')).toContain('1 unread post in')

    await omar.call('send', { text: 'Second.' })
    const afterTool = JSON.parse(hookOutput(host.store, 'PostToolUse')) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string }
    }
    expect(afterTool.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(afterTool.hookSpecificOutput.additionalContext).toContain('2 unread posts')

    // Reading the inbox clears it.
    const ahmed = await host.agent('Ahmed')
    await ahmed.call('inbox')
    expect(hookOutput(host.store, 'SessionStart')).toBe('')
  })

  it('speaks for the owner of a copy, not for the host', async () => {
    const ahmed = await host.agent('Ahmed')
    copy = await openTestCopy(host, 'Omar')
    await copy.agent.call('inbox')
    await ahmed.call('send', { text: 'For Omar.' })
    await copy.sync.syncOnce()

    expect(unreadNotice(copy.store, false)).toContain('1 unread post in the shared room from Ahmed')
  })
})

describe('hook settings', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'majlis-hooks-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('checks at session start and on each prompt, and after tool calls only when asked', () => {
    const quiet = hookSettings(undefined, false)
    expect(Object.keys(quiet)).toEqual(['SessionStart', 'UserPromptSubmit'])
    expect(quiet.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      'majlis unread --hook UserPromptSubmit',
    )

    const live = hookSettings('team', true)
    expect(live.PostToolUse[0]?.hooks[0]?.command).toBe(
      'majlis unread --hook PostToolUse --room team',
    )
  })

  it('adds itself to a settings file without disturbing what is there, and only once', () => {
    const file = join(dir, '.claude', 'settings.local.json')
    writeHookSettings(file, undefined, false)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionStart).toHaveLength(1)

    writeFileSync(
      file,
      JSON.stringify({
        permissions: { allow: ['Bash(pnpm test)'] },
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo hello' }] },
            { hooks: [{ type: 'command', command: 'majlis unread --hook SessionStart' }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
        },
      }),
    )
    writeHookSettings(file, 'team', true)
    writeHookSettings(file, 'team', true)

    const settings = JSON.parse(readFileSync(file, 'utf8'))
    expect(settings.permissions.allow).toEqual(['Bash(pnpm test)'])
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(
      settings.hooks.SessionStart.map(
        (group: { hooks: Array<{ command: string }> }) => group.hooks[0]?.command,
      ),
    ).toEqual(['echo hello', 'majlis unread --hook SessionStart --room team'])
    expect(settings.hooks.PostToolUse).toHaveLength(1)
  })
})
