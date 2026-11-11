import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Member, RoomEvent, RoomStore } from './store.ts'

/** The member this machine belongs to: the host on a room, the copy's owner on a copy. */
export function ownerOf(store: RoomStore): Member | undefined {
  const config = store.mirrorConfig()
  return store.kind() === 'mirror' && config ? store.memberById(config.meId) : store.hostMember()
}

const NOTABLE: Partial<Record<RoomEvent['kind'], string>> = {
  decision: 'a decision',
  proposal: 'a proposed resolution',
  escalation: 'a debate handed to the humans',
  contract: 'a changed contract',
  debate_opened: 'a new debate',
}

function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

/**
 * One line telling the owner's agent that the room has posts it has not read.
 * It names who posted and what kind of post, never the content: the content
 * is other people's text and is read through the inbox tool, where it is framed.
 * Empty when there is nothing to say.
 */
export function unreadNotice(store: RoomStore, onlyIfNewer: boolean): string {
  const owner = ownerOf(store)
  if (!owner) return ''
  const unread = store.unread(owner.id)
  const newest = unread.at(-1)?.seq ?? 0
  if (unread.length === 0) return ''
  if (onlyIfNewer && newest <= store.hookSeq()) return ''
  store.setHookSeq(newest)

  const authors = [...new Set(unread.map((event) => event.authorName))]
  const notable = [...new Set(unread.map((event) => NOTABLE[event.kind]).filter(Boolean))]
  return (
    `Majlis: ${unread.length} unread post${unread.length === 1 ? '' : 's'} in the shared room from ` +
    `${names(authors)}${notable.length > 0 ? `, including ${names(notable as string[])}` : ''}. ` +
    'Read them with the majlis inbox tool before continuing work they may affect.'
  )
}

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse'

/** What a Claude Code hook should print for the given event; empty to stay silent. */
export function hookOutput(store: RoomStore, event: HookEvent): string {
  // A new session knows nothing of earlier notices, so it is always told; within a session, once per new post.
  const notice = unreadNotice(store, event !== 'SessionStart')
  if (!notice) return ''
  // Claude Code reads plain output for the first two events, and needs this shape after a tool call.
  return event === 'PostToolUse'
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: notice } })
    : notice
}

interface HookGroup {
  matcher?: string
  hooks: Array<{ type: string; command: string; timeout?: number }>
}

/** The Claude Code settings that make the agent notice unread posts without being asked. */
export function hookSettings(
  room: string | undefined,
  live: boolean,
): Record<HookEvent, HookGroup[]> {
  const suffix = room ? ` --room ${room}` : ''
  const group = (event: HookEvent): HookGroup[] => [
    {
      hooks: [{ type: 'command', command: `majlis unread --hook ${event}${suffix}`, timeout: 10 }],
    },
  ]
  return {
    SessionStart: group('SessionStart'),
    UserPromptSubmit: group('UserPromptSubmit'),
    ...(live ? { PostToolUse: group('PostToolUse') } : {}),
  } as Record<HookEvent, HookGroup[]>
}

/** Adds the hooks to a Claude Code settings file, leaving everything else in it untouched. */
export function writeHookSettings(file: string, room: string | undefined, live: boolean): void {
  const current = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {}
  const hooks = (current.hooks ?? {}) as Record<string, HookGroup[]>
  for (const [event, groups] of Object.entries(hookSettings(room, live))) {
    const others = (hooks[event] ?? []).filter(
      (group) => !group.hooks?.some((hook) => hook.command?.startsWith('majlis unread')),
    )
    hooks[event] = [...others, ...groups]
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...current, hooks }, null, 2)}\n`)
}

export const projectSettingsFile = (cwd: string): string =>
  join(cwd, '.claude', 'settings.local.json')
