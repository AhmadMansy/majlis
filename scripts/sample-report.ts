/**
 * Builds sample reports from a made-up debate so the report design can be
 * judged without running a real room. Writes samples/report-*.html.
 * Run with `pnpm sample:report`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderReport } from '../src/report.ts'
import { RoomStore } from '../src/store.ts'
import {
  decide,
  omarRoundTwo,
  openSampleRoom,
  propose,
  publishReport,
  roundOne,
} from './sample-data.ts'

function build(language: 'en' | 'ar'): string {
  const store = new RoomStore(':memory:')
  const sample = openSampleRoom(store)
  roundOne(sample)
  omarRoundTwo(sample)
  decide(sample, propose(sample))
  const html = renderReport(sample.room, publishReport(sample, language))
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
