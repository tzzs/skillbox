/**
 * CI-scenario regression: on Windows runners TEMP is an 8.3 short path
 * (`RUNNER~1`) while `fs.realpath` returns the long form (`runneradmin`).
 * Simulates the mismatch locally via `dir /x` to prove checkSymlink compares
 * canonical paths on both sides. Skipped when 8.3 names are unavailable.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import { checkSymlink } from './symlinks.js'
import { createDirLink, linksSupported, cleanup } from './test-utils.js'

function shortPath(dir: string): string | undefined {
  try {
    // `dir /x` lists the 8.3 short name in the second-to-last column of the
    // target directory's row, e.g. `... <DIR> SKA94B~1 skillbox-83test-91304`.
    // Args are passed individually so `cmd /c` does not re-mangle quoting.
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', '/ad', path.dirname(dir)], {
      encoding: 'utf8',
    })
    const row = listing.split('\n').find((line) => line.includes(path.basename(dir)))
    const columns = row?.split(/\s+/).filter((c) => c !== '')
    const short = columns?.[columns.length - 2]
    return short === undefined || short.includes('\\') ? undefined : short
  } catch {
    return undefined
  }
}

describe('symlink safety (8.3 short path scenario)', () => {
  it.skipIf(!linksSupported)('accepts internal symlinks under a short-form root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-83-'))
    const shortName = shortPath(root)
    const short = shortName === undefined ? undefined : path.join(path.dirname(root), shortName)
    try {
      if (short === undefined) {
        // 8.3 short names may be disabled on the volume; the regular
        // symlinks tests already cover the canonical-path fix in that case.
        return
      }
      const member = path.join(root, 'member')
      await fs.mkdir(member)
      const link = path.join(short, 'link')
      await createDirLink(member, link)

      // The lexically identical long-form link path compares cleanly too.
      const longLink = path.join(root, 'link')
      const check = await checkSymlink(short ?? root, link)
      expect(check.insideRoot).toBe(true)
      const checkLong = await checkSymlink(short ?? root, longLink)
      expect(checkLong.insideRoot).toBe(true)
    } finally {
      await cleanup(root)
    }
  })
})
