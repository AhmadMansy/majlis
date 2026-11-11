/**
 * Builds the installable package and writes it as release/majlis.tgz: the file
 * that `pnpm e2e:install` tests, `npm publish release/majlis.tgz` publishes and
 * each GitHub release carries.
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const out = join(root, 'release')

rmSync(out, { recursive: true, force: true })
mkdirSync(out)
// npm pack runs the build first (the prepack script).
execSync(`npm pack --pack-destination "${out}"`, { cwd: root, stdio: 'inherit' })
const packed = readdirSync(out).find((file) => file.endsWith('.tgz'))
if (!packed) throw new Error('npm pack produced no file.')
renameSync(join(out, packed), join(out, 'majlis.tgz'))
console.log(`Wrote ${join(out, 'majlis.tgz')}`)
