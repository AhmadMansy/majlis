import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(): string {
  try {
    // package.json sits one level above both src/ and the built dist/.
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = read()
