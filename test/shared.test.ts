import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomStore } from '../src/store.ts'
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

describe('profiles', () => {
  it('lets each agent say what its side owns, and reminds one that has not', async () => {
    const ahmed = await host.agent('Ahmed')
    const omar = await host.agent('Omar')
    expect(await omar.call('room_status')).toContain('You have not described your side yet')

    await omar.call('set_profile', {
      profile: 'Android app (Kotlin). Owns RecitationActivity and the audio service.',
    })
    const status = await ahmed.call('room_status')
    expect(status).toContain('Omar · member')
    expect(status).toContain('Owns RecitationActivity and the audio service.')
    expect(await omar.call('room_status')).not.toContain('You have not described your side yet')
    expect(await ahmed.call('inbox')).toContain('described their side')
  })
})

describe('pinned contracts', () => {
  it('announces every change and raises the version', async () => {
    const ahmed = await host.agent('Ahmed')
    const omar = await host.agent('Omar')
    expect(await omar.call('contracts')).toBe('Nothing is pinned in this room yet.')

    expect(
      await ahmed.call('pin_contract', {
        name: 'push payload',
        content: '{ "data": { "surah": number, "ayah": number } }',
      }),
    ).toContain('version 1')
    expect(await omar.call('inbox')).toContain('Pinned "push payload" (version 1)')

    await omar.call('pin_contract', {
      name: 'Push Payload',
      content: '{ "data": { "surah": number, "ayah": number, "reciter": string } }',
      note: 'Added the reciter id.',
    })
    const notice = await ahmed.call('inbox')
    expect(notice).toContain('Changed "push payload" (version 2): Added the reciter id.')

    expect(await ahmed.call('contracts')).toContain('push payload · version 2 · Omar')
    expect(await ahmed.call('contracts', { name: 'push payload' })).toContain('"reciter": string')
    expect(await ahmed.fails('contracts', { name: 'nothing' })).toContain('no pinned contract')
    expect(await ahmed.call('room_status')).toContain('- push payload (version 2)')
  })

  it('reaches members who keep a copy', async () => {
    const ahmed = await host.agent('Ahmed')
    await ahmed.call('set_profile', { profile: 'Unity side. Owns the RecitationBridge plugin.' })
    await ahmed.call('pin_contract', {
      name: 'bridge api',
      content: 'void Pause(); void Resume();',
    })

    copy = await openTestCopy(host, 'Omar')
    expect(await copy.agent.call('contracts', { name: 'bridge api' })).toContain('void Pause();')
    expect(await copy.agent.call('room_status')).toContain('Owns the RecitationBridge plugin.')

    // A change the copy's owner makes travels to the room and comes back as the new version.
    await copy.agent.call('pin_contract', {
      name: 'bridge api',
      content: 'void Pause(); void Resume(); bool IsReady();',
      note: 'Added IsReady.',
    })
    expect(host.store.contract('bridge api')?.version).toBe(2)
    await copy.sync.syncOnce()
    expect(copy.store.contract('bridge api')?.content).toContain('IsReady')
  })
})

describe('older rooms', () => {
  it('opens a room file created before profiles, contracts and copies existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'majlis-old-'))
    const path = join(dir, 'room.db')
    // The tables exactly as the first released-to-self version created them.
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
        author_id TEXT NOT NULL REFERENCES members(id), body TEXT NOT NULL, reply_to INTEGER
      );
      INSERT INTO members (id, name, role, token_hash, created_at) VALUES ('m1', 'Ahmed', 'host', 'h1', '2026-11-10T00:00:00Z');
      INSERT INTO events (ts, author_id, body) VALUES ('2026-11-10T00:00:01Z', 'm1', 'from the old version');
    `)
    old.close()

    const store = new RoomStore(path)
    try {
      expect(store.kind()).toBe('host')
      expect(store.memberById('m1')?.profile).toBe('')
      expect(store.history(5)[0]).toMatchObject({ kind: 'message', body: 'from the old version' })
      store.setProfile('m1', 'Unity side.')
      expect(store.members()[0]?.profile).toBe('Unity side.')
      expect(store.contracts()).toEqual([])
      expect(store.outbox()).toEqual([])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
