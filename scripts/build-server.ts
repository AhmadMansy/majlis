/**
 * Compiles src/ to plain JavaScript in dist/. In this folder the app runs
 * straight from the TypeScript sources, but Node refuses to do that for files
 * under node_modules, which is where an installed copy lives.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' },
)
if (!existsSync(join(dist, 'cli.js'))) throw new Error('The build produced no dist/cli.js.')
console.log('Built dist/')
