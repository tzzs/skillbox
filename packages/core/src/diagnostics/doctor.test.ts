import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { createDefaultAgentRegistry } from '../agent/index.js'
import { writeManifest, emptyManifest } from '../manifest/index.js'
import { writeLockfile, emptyLockfile } from '../lockfile/index.js'
import { createDebugBundle, runDoctor, scanForLeaks } from './doctor.js'

function context(repositoryRoot: string, homeRoot: string) {
  return {
    repositoryRoot,
    homeRoot,
    registry: createDefaultAgentRegistry(),
    version: '0.1.0',
  }
}

describe('runDoctor', () => {
  it('reports healthy probes for a valid repository + home', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'repo')
      await fs.mkdir(repo, { recursive: true })
      await writeManifest(repo, emptyManifest())
      await writeLockfile(repo, emptyLockfile())

      const report = await runDoctor(context(repo, path.join(dir, 'home')))

      const byName = new Map(report.probes.map((probe) => [probe.name, probe]))
      expect(byName.get('manifest')?.ok).toBe(true)
      expect(byName.get('lockfile')?.ok).toBe(true)
      expect(byName.get('consistency')?.ok).toBe(true)
      expect(byName.get('home')?.ok).toBe(true)
      expect(byName.get('config')?.ok).toBe(true)
    })
  })

  it('reports failures for a missing repository without throwing', async () => {
    await withTempDir(async (dir) => {
      const repo = path.join(dir, 'no-such-repo')
      const report = await runDoctor(context(repo, path.join(dir, 'home')))

      const byName = new Map(report.probes.map((probe) => [probe.name, probe]))
      expect(byName.get('manifest')?.ok).toBe(false)
      expect(byName.get('lockfile')?.ok).toBe(false)
    })
  })
})

describe('debug bundle', () => {
  it('redacts log lines and reports an empty leak check for clean input', async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, 'home')
      const repo = path.join(dir, 'repo')
      await fs.mkdir(path.join(home, 'logs'), { recursive: true })
      await fs.mkdir(repo, { recursive: true })
      await fs.writeFile(
        path.join(home, 'logs', 'skillbox.log'),
        '[2026-08-14T00:00:00.000Z] INFO token = super-secret-value\n',
        'utf8',
      )

      const bundle = await createDebugBundle(context(repo, home))

      expect(bundle.logTail[0]).toContain('[REDACTED]')
      expect(bundle.leakCheck.findings).toEqual([])
      expect(bundle.repository.manifest).toBe('missing')
    })
  })

  it('detects secret patterns that survive redaction (leak scan)', async () => {
    const findings = scanForLeaks([
      { source: 'config.json', text: '{"token":"ghp_123456789012345678901234"}' },
      { source: 'skillbox.log', text: 'Authorization: Bearer abc.def.ghi' },
      { source: 'skillbox.log', text: 'no secrets here' },
    ])

    expect(findings).toEqual([
      { pattern: 'github-token', source: 'config.json', count: 1 },
      { pattern: 'authorization-header', source: 'skillbox.log', count: 1 },
    ])
  })
})
